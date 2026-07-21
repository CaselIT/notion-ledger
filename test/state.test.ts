import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { PageMetadata } from "../src/notion";
import {
  beginIncrementalMirror,
  INDEX_FILENAME,
  planPagePaths,
  planRootPaths,
  reconcileMirror,
  ROOTS_INDEX_FILENAME,
} from "../src/state";

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

test("persists each page and its check time before reconciliation finishes", async (t) => {
  const outputDir = await temporaryDirectory(t);
  const checkedAt = new Date("2026-07-21T12:34:56.000Z");
  const writer = await beginIncrementalMirror({
    outputDir,
    rootPageId,
    filenameStrategy: "slug-and-id",
    deleteOrphans: true,
    now: () => checkedAt,
  });

  await writer.writePage(renderedPage(rootPageId, "Root"));

  const index = JSON.parse(
    await fs.readFile(path.join(outputDir, INDEX_FILENAME), "utf8"),
  );
  const entry = index.pages[rootPageId];
  assert.equal(entry.last_edited_at, "2026-07-17T09:30:00.000Z");
  assert.equal(entry.last_checked_at, checkedAt.toISOString());
  assert.equal(
    await fs.readFile(path.join(outputDir, entry.path), "utf8"),
    "Root\n",
  );
  assert.deepEqual(
    await writer.finish(),
    { pagesExported: 1, pagesChanged: 1, pagesDeleted: 0 },
  );
});

test("preserves unseen indexed pages until reconciliation finishes", async (t) => {
  const outputDir = await temporaryDirectory(t);
  await reconcileMirror({
    outputDir,
    rootPageId,
    renderedPages: [renderedPage(rootPageId, "Root"), renderedPage(childPageId, "Child")],
    filenameStrategy: "slug-and-id",
    deleteOrphans: true,
  });
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

test("plans stable paths before pages are rendered", async (t) => {
  const outputDir = await temporaryDirectory(t);
  await reconcileMirror({
    outputDir,
    rootPageId,
    renderedPages: [renderedPage(rootPageId, "Original")],
    filenameStrategy: "slug-and-id",
    deleteOrphans: true,
  });

  const pages = [
    renderedPage(rootPageId, "Renamed").page,
    renderedPage(childPageId, "Database task").page,
  ];
  const paths = await planPagePaths(
    outputDir,
    rootPageId,
    pages,
    "slug-and-id",
  );

  assert.equal(paths[rootPageId], `original--${rootPageId.slice(0, 8)}.md`);
  assert.equal(paths[childPageId], `database-task--${childPageId.slice(0, 8)}.md`);
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
