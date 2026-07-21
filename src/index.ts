import path from "node:path";
import * as core from "@actions/core";
import { Client } from "@notionhq/client";
import {
  parseBoolean,
  parseFilenameStrategy,
  parseRootPageIds,
  resolveOutputDirectory,
} from "./inputs";
import { discoverPages } from "./notion";
import { renderPage } from "./render";
import {
  beginIncrementalMirror,
  type IncrementalMirrorWriter,
  planRootPaths,
} from "./state";

type LogLevel = "debug" | "info" | "warn";

const actionLoggers: Record<LogLevel, (message: string) => void> = {
  debug: core.debug,
  info: core.info,
  warn: core.warning,
};

function log(level: LogLevel, message: string): void {
  actionLoggers[level](message);
}

export async function run(): Promise<void> {
  const notionToken = core.getInput("notion-token", { required: true });
  const rootPageIds = parseRootPageIds(core.getInput("root-pages", { required: true }));
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const outputDir = resolveOutputDirectory(
    workspace,
    core.getInput("output-dir") || "docs/notion",
  );
  const addFrontmatter = parseBoolean(
    core.getInput("add-frontmatter") || "true",
    "add-frontmatter",
  );
  const deleteOrphans = parseBoolean(
    core.getInput("delete-orphans") || "true",
    "delete-orphans",
  );
  const filenameStrategy = parseFilenameStrategy(
    core.getInput("filename-strategy") || "slug-and-id",
  );

  const notion = new Client({ auth: notionToken });

  let pagesExported = 0;
  let pagesChanged = 0;
  let pagesDeleted = 0;
  let warnedAboutUserInfo = false;
  const warnedUnknownBlocks = new Set<string>();
  for (const rootPageId of rootPageIds) {
    log("info", `Discovering pages below Notion root ${rootPageId}.`);
    let writer: IncrementalMirrorWriter | undefined;
    await discoverPages(notion, rootPageId, {
      onProgress: (message) => log("debug", message),
      onPage: async (page) => {
        if (!writer) {
          if (page.id !== rootPageId) {
            throw new Error(`Notion root page ${rootPageId} was not discovered first.`);
          }
          const rootPaths = await planRootPaths(outputDir, [page]);
          writer = await beginIncrementalMirror({
            outputDir: path.join(outputDir, rootPaths[rootPageId]),
            rootPageId,
            filenameStrategy,
            deleteOrphans,
          });
        }
        await writer.writePage({
          page,
          content: renderPage(page, page.markdown, addFrontmatter),
        });
      },
      onUnknownBlockUnresolved: (blockId) => {
        if (!warnedUnknownBlocks.has(blockId)) {
          warnedUnknownBlocks.add(blockId);
          log("warn",
            `Notion could not resolve Markdown block ${blockId}; `
            + "preserving its <unknown> placeholder.",
          );
        }
      },
      onUserInfoUnavailable: () => {
        if (!warnedAboutUserInfo) {
          warnedAboutUserInfo = true;
          log("warn",
            "Skipping last_edited_by because the Notion integration does not have "
            + "User information without email addresses capability.",
          );
        }
      },
    });
    if (!writer) {
      throw new Error(`Notion root page ${rootPageId} was not discovered.`);
    }
    const result = await writer.finish();
    pagesExported += result.pagesExported;
    pagesChanged += result.pagesChanged;
    pagesDeleted += result.pagesDeleted;
  }

  core.setOutput("pages-exported", pagesExported);
  core.setOutput("pages-changed", pagesChanged);
  core.setOutput("pages-deleted", pagesDeleted);
  log("info",
    `Exported ${pagesExported} page(s) from ${rootPageIds.length} root(s); `
    + `changed ${pagesChanged}; deleted ${pagesDeleted}.`,
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    await core.summary
      .addHeading("Notion mirror")
      .addTable([
        [{ data: "Roots mirrored", header: true }, String(rootPageIds.length)],
        [{ data: "Pages exported", header: true }, String(pagesExported)],
        [{ data: "Pages changed", header: true }, String(pagesChanged)],
        [{ data: "Pages deleted", header: true }, String(pagesDeleted)],
      ])
      .write();
  }
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
