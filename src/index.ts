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

  // Track the writer for the root currently being mirrored so its progress can
  // be saved if the run fails or is interrupted before reconciliation finishes.
  let activeWriter: IncrementalMirrorWriter | undefined;
  const saveProgress = async (): Promise<void> => {
    try {
      await activeWriter?.persist();
    } catch (error: unknown) {
      log("warn",
        `Could not save mirror index progress: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  let interrupted = false;
  const handleSignal = (signal: NodeJS.Signals): void => {
    if (interrupted) {
      return;
    }
    interrupted = true;
    void (async () => {
      log("warn", `Received ${signal}; saving mirror index progress before exiting.`);
      await saveProgress();
      process.exit(130);
    })();
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  try {
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
            activeWriter = writer;
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
              "Using Notion editor IDs for last_edited_by because the integration does not have "
              + "User information without email addresses capability.",
            );
          }
        },
      });
      if (!writer) {
        throw new Error(`Notion root page ${rootPageId} was not discovered.`);
      }
      const result = await writer.finish();
      activeWriter = undefined;
      pagesExported += result.pagesExported;
      pagesChanged += result.pagesChanged;
      pagesDeleted += result.pagesDeleted;
    }
  } catch (error: unknown) {
    // Save whatever was successfully exported before the failure, without
    // deleting orphans, so the next run can resume from partial progress.
    await saveProgress();
    throw error;
  } finally {
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
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
