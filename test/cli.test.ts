import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { readCliInputs } from "../src/cli";

const rootPageId = "8fe4a1b2123434567890abcdefabcdef";

test("reads CLI defaults and uses the Azure checkout directory", () => {
  const workspace = path.resolve("azure-workspace");
  assert.deepEqual(readCliInputs({
    NOTION_TOKEN: "secret-token",
    ROOT_PAGES: rootPageId,
    BUILD_SOURCESDIRECTORY: workspace,
  }, path.resolve("other-workspace")), {
    notionToken: "secret-token",
    rootPageIds: [rootPageId],
    outputDir: path.join(workspace, "docs", "notion"),
    addFrontmatter: true,
    deleteOrphans: true,
    fullExport: false,
    filenameStrategy: "slug-and-id",
  });
});

test("reads CLI option overrides", () => {
  const workspace = path.resolve("workspace");
  const result = readCliInputs({
    NOTION_TOKEN: "secret-token",
    ROOT_PAGES: rootPageId,
    OUTPUT_DIR: "generated/notion",
    ADD_FRONTMATTER: "false",
    DELETE_ORPHANS: "false",
    FULL_EXPORT: "true",
    FILENAME_STRATEGY: "stable-id",
  }, workspace);

  assert.equal(result.outputDir, path.join(workspace, "generated", "notion"));
  assert.equal(result.addFrontmatter, false);
  assert.equal(result.deleteOrphans, false);
  assert.equal(result.fullExport, true);
  assert.equal(result.filenameStrategy, "stable-id");
});

test("requires CLI secrets and roots", () => {
  assert.throws(() => readCliInputs({ ROOT_PAGES: rootPageId }), /NOTION_TOKEN is required/);
  assert.throws(() => readCliInputs({ NOTION_TOKEN: "secret-token" }), /ROOT_PAGES is required/);
});