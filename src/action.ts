import * as core from "@actions/core";
import {
  parseBoolean,
  parseFilenameStrategy,
  parseRootPageIds,
  resolveOutputDirectory,
} from "./inputs";
import { runMirror, type LogLevel } from "./lib";

const actionLoggers: Record<LogLevel, (message: string) => void> = {
  debug: core.debug,
  info: core.info,
  warn: core.warning,
};

function log(level: LogLevel, message: string): void {
  actionLoggers[level](message);
}

export async function runAction(): Promise<void> {
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
  const fullExport = parseBoolean(
    core.getInput("full-export") || "false",
    "full-export",
  );
  const filenameStrategy = parseFilenameStrategy(
    core.getInput("filename-strategy") || "slug-and-id",
  );

  const result = await runMirror({
    notionToken,
    rootPageIds,
    outputDir,
    addFrontmatter,
    deleteOrphans,
    fullExport,
    filenameStrategy,
    logger: {
      debug: (message) => log("debug", message),
      info: (message) => log("info", message),
      warn: (message) => log("warn", message),
    },
  });

  core.setOutput("pages-exported", result.pagesExported);
  core.setOutput("pages-changed", result.pagesChanged);
  core.setOutput("pages-deleted", result.pagesDeleted);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await core.summary
      .addHeading("Notion mirror")
      .addTable([
        [{ data: "Roots mirrored", header: true }, String(result.rootsMirrored)],
        [{ data: "Pages exported", header: true }, String(result.pagesExported)],
        [{ data: "Pages changed", header: true }, String(result.pagesChanged)],
        [{ data: "Pages deleted", header: true }, String(result.pagesDeleted)],
      ])
      .write();
  }
}