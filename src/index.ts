import * as core from "@actions/core";
import { Client } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import {
  parseBoolean,
  parseFilenameStrategy,
  parseRootPageId,
  resolveOutputDirectory,
} from "./inputs";
import { discoverPages } from "./notion";
import {
  configureInlineDatabaseRenderer,
  convertPage,
  renderPage,
} from "./render";
import { planPagePaths, reconcileMirror } from "./state";

export async function run(): Promise<void> {
  const notionToken = core.getInput("notion-token", { required: true });
  const rootPageId = parseRootPageId(core.getInput("root-page", { required: true }));
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
  const n2m = new NotionToMarkdown({
    notionClient: notion,
    config: { parseChildPages: false },
  });

  core.info("Discovering pages below the configured Notion root.");
  const pages = await discoverPages(notion, rootPageId, {
    onUserInfoUnavailable: () => core.warning(
      "Skipping last_edited_by because the Notion integration does not have "
      + "User information without email addresses capability.",
    ),
  });
  const pagePaths = await planPagePaths(
    outputDir,
    rootPageId,
    pages,
    filenameStrategy,
  );
  const renderedPages = [];
  for (const page of pages) {
    core.info(`Rendering "${page.title}" (${page.id}).`);
    configureInlineDatabaseRenderer(n2m, notion, pagePaths[page.id], pagePaths);
    const markdown = await convertPage(n2m, page.id);
    renderedPages.push({
      page,
      content: renderPage(page, markdown, addFrontmatter),
    });
  }

  const result = await reconcileMirror({
    outputDir,
    rootPageId,
    renderedPages,
    pagePaths,
    filenameStrategy,
    deleteOrphans,
  });

  core.setOutput("pages-exported", result.pagesExported);
  core.setOutput("pages-changed", result.pagesChanged);
  core.setOutput("pages-deleted", result.pagesDeleted);
  core.info(
    `Exported ${result.pagesExported} page(s); `
    + `changed ${result.pagesChanged}; deleted ${result.pagesDeleted}.`,
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    await core.summary
      .addHeading("Notion mirror")
      .addTable([
        [{ data: "Pages exported", header: true }, String(result.pagesExported)],
        [{ data: "Pages changed", header: true }, String(result.pagesChanged)],
        [{ data: "Pages deleted", header: true }, String(result.pagesDeleted)],
      ])
      .write();
  }
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
