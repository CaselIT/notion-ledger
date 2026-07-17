import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { PageMetadata } from "../src/notion";
import { INDEX_FILENAME, reconcileMirror } from "../src/state";

const rootPageId = "11111111111111111111111111111111";
const childPageId = "22222222222222222222222222222222";

function renderedPage(id: string, title: string, content = title): {
  page: PageMetadata;
  content: string;
} {
  return {
    page: {
      id,
      url: `https://notion.so/${id}`,
      title,
      lastEditedAt: "2026-07-17T09:30:00.000Z",
    },
    content: `${content}\n`,
  };
}

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "notion-ledger-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("writes deterministic files and preserves paths across title changes", async (t) => {
  const outputDir = await temporaryDirectory(t);
  const initial = [
    renderedPage(rootPageId, "Root"),
    renderedPage(childPageId, "Child"),
  ];

  assert.deepEqual(
    await reconcileMirror({
      outputDir,
      rootPageId,
      renderedPages: initial,
      filenameStrategy: "slug-and-id",
      deleteOrphans: true,
    }),
    { pagesExported: 2, pagesChanged: 2, pagesDeleted: 0 },
  );

  const initialIndex = JSON.parse(
    await fs.readFile(path.join(outputDir, INDEX_FILENAME), "utf8"),
  );
  const childPath = initialIndex.pages[childPageId].path;

  assert.deepEqual(
    await reconcileMirror({
      outputDir,
      rootPageId,
      renderedPages: initial,
      filenameStrategy: "slug-and-id",
      deleteOrphans: true,
    }),
    { pagesExported: 2, pagesChanged: 0, pagesDeleted: 0 },
  );

  await reconcileMirror({
    outputDir,
    rootPageId,
    renderedPages: [
      renderedPage(rootPageId, "Root"),
      renderedPage(childPageId, "Renamed child", "updated"),
    ],
    filenameStrategy: "slug-and-id",
    deleteOrphans: true,
  });
  const renamedIndex = JSON.parse(
    await fs.readFile(path.join(outputDir, INDEX_FILENAME), "utf8"),
  );
  assert.equal(renamedIndex.pages[childPageId].path, childPath);
  assert.equal(await fs.readFile(path.join(outputDir, childPath), "utf8"), "updated\n");
});

test("deletes only indexed orphan files when enabled", async (t) => {
  const outputDir = await temporaryDirectory(t);
  await reconcileMirror({
    outputDir,
    rootPageId,
    renderedPages: [renderedPage(rootPageId, "Root"), renderedPage(childPageId, "Child")],
    filenameStrategy: "slug-and-id",
    deleteOrphans: true,
  });
  await fs.writeFile(path.join(outputDir, "user-authored.md"), "keep\n");

  const result = await reconcileMirror({
    outputDir,
    rootPageId,
    renderedPages: [renderedPage(rootPageId, "Root")],
    filenameStrategy: "slug-and-id",
    deleteOrphans: true,
  });

  assert.equal(result.pagesDeleted, 1);
  assert.equal(await fs.readFile(path.join(outputDir, "user-authored.md"), "utf8"), "keep\n");
});

test("rejects unsafe paths from a tampered index", async (t) => {
  const outputDir = await temporaryDirectory(t);
  await fs.writeFile(
    path.join(outputDir, INDEX_FILENAME),
    JSON.stringify({
      version: 1,
      root_page_id: rootPageId,
      pages: {
        [childPageId]: { path: "../outside.md", title: "Unsafe" },
      },
    }),
  );

  await assert.rejects(
    reconcileMirror({
      outputDir,
      rootPageId,
      renderedPages: [],
      filenameStrategy: "slug-and-id",
      deleteOrphans: true,
    }),
    /escapes output-dir/,
  );
});
