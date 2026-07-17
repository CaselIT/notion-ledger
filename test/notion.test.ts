import assert from "node:assert/strict";
import test from "node:test";
import { discoverPages, findChildPageIds } from "../src/notion";

const rootId = "11111111111111111111111111111111";
const childId = "22222222222222222222222222222222";
const nestedBlockId = "33333333-3333-3333-3333-333333333333";

function createNotionMock(): Parameters<typeof discoverPages>[0] {
  const pages: Record<string, unknown> = {
    [rootId]: {
      object: "page",
      id: rootId,
      url: `https://notion.so/${rootId}`,
      last_edited_time: "2026-07-17T09:30:00.000Z",
      last_edited_by: { object: "user", id: "editor", name: "Editor" },
      properties: {
        Name: {
          type: "title",
          title: [{ plain_text: "Root" }],
        },
      },
    },
    [childId]: {
      object: "page",
      id: childId,
      url: `https://notion.so/${childId}`,
      last_edited_time: "2026-07-17T10:00:00.000Z",
      last_edited_by: { object: "user", id: "editor" },
      properties: {
        title: {
          type: "title",
          title: [{ plain_text: "Child" }],
        },
      },
    },
  };

  const mock = {
    pages: {
      retrieve: async ({ page_id: pageId }: { page_id: string }) => pages[pageId],
    },
    blocks: {
      children: {
        list: async ({
          block_id: blockId,
          start_cursor: cursor,
        }: {
          block_id: string;
          start_cursor?: string;
        }) => {
          if (blockId === rootId && !cursor) {
            return {
              results: [{ id: "paragraph", type: "paragraph", has_children: false }],
              has_more: true,
              next_cursor: "page-2",
            };
          }
          if (blockId === rootId && cursor === "page-2") {
            return {
              results: [{ id: nestedBlockId, type: "toggle", has_children: true }],
              has_more: false,
              next_cursor: null,
            };
          }
          if (blockId === nestedBlockId) {
            return {
              results: [{ id: childId, type: "child_page", has_children: true }],
              has_more: false,
              next_cursor: null,
            };
          }
          return { results: [], has_more: false, next_cursor: null };
        },
      },
    },
  };
  return mock;
}

test("finds child pages inside nested blocks and across pagination", async () => {
  assert.deepEqual(await findChildPageIds(createNotionMock(), rootId), [childId]);
});

test("discovers root and descendant metadata", async () => {
  const pages = await discoverPages(createNotionMock(), rootId);
  assert.deepEqual(
    pages.map(({ id, title }) => ({ id, title })),
    [
      { id: rootId, title: "Root" },
      { id: childId, title: "Child" },
    ],
  );
  assert.equal(pages[0].lastEditedBy, "Editor");
  assert.equal(pages[1].lastEditedBy, undefined);
});
