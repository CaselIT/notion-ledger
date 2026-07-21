import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { PageMetadata } from "../src/notion";
import {
  beginIncrementalMirror,
  INDEX_FILENAME,
  planRootPaths,
  type ReconcileResult,
  ROOTS_INDEX_FILENAME,
} from "../src/state";

const rootPageId = "11111111111111111111111111111111";
const childPageId = "22222222222222222222222222222222";

interface RenderedPage {
  page: PageMetadata;
  content: string;
}

function renderedPage(id: string, title: string, content = title): RenderedPage {
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

async function mirror(
  outputDir: string,
  renderedPages: RenderedPage[],
  options: { deleteOrphans?: boolean } = {},
): Promise<ReconcileResult> {
  const writer = await beginIncrementalMirror({
    outputDir,
    rootPageId,
    filenameStrategy: "slug-and-id",
    deleteOrphans: options.deleteOrphans ?? true,
  });
  for (const rendered of renderedPages) {
    await writer.writePage(rendered);
  }
  return writer.finish();
}

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "notion-ledger-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("writes page files eagerly but persists the index only on finish", async (t) => {
  const outputDir = await temporaryDirectory(t);
  const writer = await beginIncrementalMirror({
    outputDir,
    rootPageId,
    filenameStrategy: "slug-and-id",
    deleteOrphans: true,
  });

  await writer.writePage(renderedPage(rootPageId, "Root"));

  const pagePath = path.join(outputDir, `root--${rootPageId.slice(0, 8)}.md`);
  assert.equal(await fs.readFile(pagePath, "utf8"), "Root\n");
  await assert.rejects(fs.access(path.join(outputDir, INDEX_FILENAME)));

  assert.deepEqual(
    await writer.finish(),
    { pagesExported: 1, pagesChanged: 1, pagesDeleted: 0 },
  );

  const index = JSON.parse(
    await fs.readFile(path.join(outputDir, INDEX_FILENAME), "utf8"),
  );
  const entry = index.pages[rootPageId];
  assert.equal(entry.last_edited_at, "2026-07-17T09:30:00.000Z");
  assert.equal(entry.path, `root--${rootPageId.slice(0, 8)}.md`);
  assert.ok(!("last_checked_at" in entry));
});

test("preserves unseen indexed pages until reconciliation finishes", async (t) => {
  const outputDir = await temporaryDirectory(t);
  await mirror(outputDir, [
    renderedPage(rootPageId, "Root"),
    renderedPage(childPageId, "Child"),
  ]);
  const writer = await beginIncrementalMirror({
    outputDir,
    rootPageId,
    filenameStrategy: "slug-and-id",
    deleteOrphans: true,
  });

  await writer.writePage(renderedPage(rootPageId, "Root"));

  const partialIndex = JSON.parse(
    await fs.readFile(path.join(outputDir, INDEX_FILENAME), "utf8"),
  );
  const childPath = partialIndex.pages[childPageId].path;
  assert.ok(partialIndex.pages[childPageId]);
  assert.equal(await fs.readFile(path.join(outputDir, childPath), "utf8"), "Child\n");

  assert.deepEqual(
    await writer.finish(),
    { pagesExported: 1, pagesChanged: 0, pagesDeleted: 1 },
  );
  await assert.rejects(fs.access(path.join(outputDir, childPath)));
});

test("persist saves partial progress without deleting orphans", async (t) => {
  const outputDir = await temporaryDirectory(t);
  await mirror(outputDir, [
    renderedPage(rootPageId, "Root"),
    renderedPage(childPageId, "Child"),
  ]);

  const writer = await beginIncrementalMirror({
    outputDir,
    rootPageId,
    filenameStrategy: "slug-and-id",
    deleteOrphans: true,
  });
  await writer.writePage(renderedPage(rootPageId, "Root", "Updated"));
  await writer.persist();

  const index = JSON.parse(
    await fs.readFile(path.join(outputDir, INDEX_FILENAME), "utf8"),
  );
  // The re-exported root and the not-yet-visited child both remain indexed.
  assert.ok(index.pages[rootPageId]);
  assert.ok(index.pages[childPageId]);
  // The unseen child file is preserved because persist skips orphan deletion.
  assert.equal(
    await fs.readFile(path.join(outputDir, index.pages[childPageId].path), "utf8"),
    "Child\n",
  );
});

test("does not index a page whose file write fails", async (t) => {
  const outputDir = await temporaryDirectory(t);
  // Occupy the page's target path with a directory so the file write fails.
  await fs.mkdir(path.join(outputDir, `root--${rootPageId.slice(0, 8)}.md`), {
    recursive: true,
  });

  const writer = await beginIncrementalMirror({
    outputDir,
    rootPageId,
    filenameStrategy: "slug-and-id",
    deleteOrphans: true,
  });
  await assert.rejects(writer.writePage(renderedPage(rootPageId, "Root")));
  await writer.persist();

  const index = JSON.parse(
    await fs.readFile(path.join(outputDir, INDEX_FILENAME), "utf8"),
  );
  assert.equal(index.pages[rootPageId], undefined);
});

test("writes deterministic files and preserves paths across title changes", async (t) => {
  const outputDir = await temporaryDirectory(t);
  const initial = [
    renderedPage(rootPageId, "Root"),
    renderedPage(childPageId, "Child"),
  ];

  assert.deepEqual(
    await mirror(outputDir, initial),
    { pagesExported: 2, pagesChanged: 2, pagesDeleted: 0 },
  );

  const initialIndex = JSON.parse(
    await fs.readFile(path.join(outputDir, INDEX_FILENAME), "utf8"),
  );
  const childPath = initialIndex.pages[childPageId].path;

  assert.deepEqual(
    await mirror(outputDir, initial),
    { pagesExported: 2, pagesChanged: 0, pagesDeleted: 0 },
  );

  await mirror(outputDir, [
    renderedPage(rootPageId, "Root"),
    renderedPage(childPageId, "Renamed child", "updated"),
  ]);
  const renamedIndex = JSON.parse(
    await fs.readFile(path.join(outputDir, INDEX_FILENAME), "utf8"),
  );
  assert.equal(renamedIndex.pages[childPageId].path, childPath);
  assert.equal(await fs.readFile(path.join(outputDir, childPath), "utf8"), "updated\n");
});

test("allocates slug paths for new pages and keeps them across renames", async (t) => {
  const outputDir = await temporaryDirectory(t);
  await mirror(outputDir, [renderedPage(rootPageId, "Original")]);

  await mirror(outputDir, [
    renderedPage(rootPageId, "Renamed"),
    renderedPage(childPageId, "Database task"),
  ]);

  const index = JSON.parse(
    await fs.readFile(path.join(outputDir, INDEX_FILENAME), "utf8"),
  );
  assert.equal(index.pages[rootPageId].path, `original--${rootPageId.slice(0, 8)}.md`);
  assert.equal(index.pages[childPageId].path, `database-task--${childPageId.slice(0, 8)}.md`);
});

test("preserves root directories across title and configuration changes", async (t) => {
  const outputDir = await temporaryDirectory(t);
  const firstRoot = renderedPage(rootPageId, "Engineering").page;
  const secondRoot = renderedPage(childPageId, "Personal").page;

  const initial = await planRootPaths(outputDir, [firstRoot, secondRoot]);
  assert.equal(initial[rootPageId], `engineering--${rootPageId.slice(0, 8)}`);
  assert.equal(initial[childPageId], `personal--${childPageId.slice(0, 8)}`);

  const renamed = await planRootPaths(outputDir, [
    { ...firstRoot, title: "Renamed engineering" },
  ]);
  assert.equal(renamed[rootPageId], initial[rootPageId]);

  const restored = await planRootPaths(outputDir, [secondRoot]);
  assert.equal(restored[childPageId], initial[childPageId]);
});

test("rejects unsafe paths from a tampered root index", async (t) => {
  const outputDir = await temporaryDirectory(t);
  await fs.writeFile(
    path.join(outputDir, ROOTS_INDEX_FILENAME),
    JSON.stringify({
      version: 1,
      roots: {
        [rootPageId]: { path: ".", title: "Unsafe" },
      },
    }),
  );

  await assert.rejects(
    planRootPaths(outputDir, [renderedPage(rootPageId, "Root").page]),
    /invalid entry/,
  );
});

test("deletes only indexed orphan files when enabled", async (t) => {
  const outputDir = await temporaryDirectory(t);
  await mirror(outputDir, [
    renderedPage(rootPageId, "Root"),
    renderedPage(childPageId, "Child"),
  ]);
  await fs.writeFile(path.join(outputDir, "user-authored.md"), "keep\n");

  const result = await mirror(outputDir, [renderedPage(rootPageId, "Root")]);

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
    beginIncrementalMirror({
      outputDir,
      rootPageId,
      filenameStrategy: "slug-and-id",
      deleteOrphans: true,
    }),
    /escapes output-dir/,
  );
});
