import path from "node:path";
import * as core from "@actions/core";
import { Client } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import {
  parseBoolean,
  parseFilenameStrategy,
  parseRootPageIds,
  resolveOutputDirectory,
} from "./inputs";
import { discoverPages, type PageMetadata } from "./notion";
import {
  configureInlineDatabaseRenderer,
  convertPage,
  renderPage,
} from "./render";
import { planPagePaths, planRootPaths, reconcileMirror } from "./state";

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
  const n2m = new NotionToMarkdown({
    notionClient: notion,
    config: { parseChildPages: false },
  });

  let pagesExported = 0;
  let pagesChanged = 0;
  let pagesDeleted = 0;
  let warnedAboutUserInfo = false;
  const discoveries: Array<{ rootPageId: string; pages: PageMetadata[] }> = [];
  for (const rootPageId of rootPageIds) {
    core.info(`Discovering pages below Notion root ${rootPageId}.`);
    const pages = await discoverPages(notion, rootPageId, {
      onUserInfoUnavailable: () => {
        if (!warnedAboutUserInfo) {
          warnedAboutUserInfo = true;
          core.warning(
            "Skipping last_edited_by because the Notion integration does not have "
            + "User information without email addresses capability.",
          );
        }
      },
    });
    const rootPage = pages[0];
    if (!rootPage || rootPage.id !== rootPageId) {
      throw new Error(`Notion root page ${rootPageId} was not discovered.`);
    }
    discoveries.push({ rootPageId, pages });
  }
  const rootPaths = await planRootPaths(
    outputDir,
    discoveries.map(({ pages }) => pages[0]),
  );

  for (const { rootPageId, pages } of discoveries) {
    const rootOutputDir = path.join(
      outputDir,
      rootPaths[rootPageId],
    );
    const pagePaths = await planPagePaths(
      rootOutputDir,
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
      outputDir: rootOutputDir,
      rootPageId,
      renderedPages,
      pagePaths,
      filenameStrategy,
      deleteOrphans,
    });
    pagesExported += result.pagesExported;
    pagesChanged += result.pagesChanged;
    pagesDeleted += result.pagesDeleted;
  }

  core.setOutput("pages-exported", pagesExported);
  core.setOutput("pages-changed", pagesChanged);
  core.setOutput("pages-deleted", pagesDeleted);
  core.info(
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
