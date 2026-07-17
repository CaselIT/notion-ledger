import assert from "node:assert/strict";
import test from "node:test";
import { APIErrorCode, APIResponseError } from "@notionhq/client";
import {
  discoverPages,
  findChildPageIds,
  queryInlineDatabaseRows,
} from "../src/notion";

const rootId = "11111111111111111111111111111111";
const childId = "22222222222222222222222222222222";
const nestedBlockId = "33333333-3333-3333-3333-333333333333";

function createNotionMock(): Parameters<typeof discoverPages>[0] & {
  userRetrievals: () => number;
} {
  let userRetrievals = 0;
  const pages: Record<string, unknown> = {
    [rootId]: {
      object: "page",
      id: rootId,
      url: `https://notion.so/${rootId}`,
      last_edited_time: "2026-07-17T09:30:00.000Z",
      last_edited_by: { object: "user", id: "editor" },
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
    userRetrievals: () => userRetrievals,
    pages: {
      retrieve: async ({ page_id: pageId }: { page_id: string }) => pages[pageId],
    },
    databases: {
      retrieve: async () => ({ object: "database", data_sources: [] }),
    },
    dataSources: {
      query: async () => ({ results: [], has_more: false, next_cursor: null }),
    },
    users: {
      retrieve: async ({ user_id: userId }: { user_id: string }) => {
        userRetrievals += 1;
        return { object: "user", id: userId, name: "Editor" };
      },
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

function restrictedUserInformationError(): APIResponseError {
  return new APIResponseError({
    code: APIErrorCode.RestrictedResource,
    status: 403,
    message: "Insufficient permissions for this endpoint.",
    headers: new Headers(),
    rawBodyText: "",
    additional_data: undefined,
    request_id: undefined,
  });
}

test("finds child pages inside nested blocks and across pagination", async () => {
  assert.deepEqual(await findChildPageIds(createNotionMock(), rootId), [childId]);
});

test("queries all pages in an inline database", async () => {
  const cursors: Array<string | undefined> = [];
  const rows = await queryInlineDatabaseRows({
    databases: {
      retrieve: async () => ({
        object: "database",
        data_sources: [{ id: "data-source-id", name: "Tasks" }],
      }),
    },
    dataSources: {
      query: async ({ start_cursor: cursor }) => {
        cursors.push(cursor);
        return cursor
          ? { results: [{ id: "second" }], has_more: false, next_cursor: null }
          : { results: [{ id: "first" }], has_more: true, next_cursor: "next" };
      },
    },
  }, "database-id");

  assert.deepEqual(rows, [{ id: "first" }, { id: "second" }]);
  assert.deepEqual(cursors, [undefined, "next"]);
});

test("discovers root and descendant metadata", async () => {
  const notion = createNotionMock();
  const pages = await discoverPages(notion, rootId);
  assert.deepEqual(
    pages.map(({ id, title }) => ({ id, title })),
    [
      { id: rootId, title: "Root" },
      { id: childId, title: "Child" },
    ],
  );
  assert.equal(pages[0].lastEditedBy, "Editor");
  assert.equal(pages[1].lastEditedBy, "Editor");
  assert.equal(notion.userRetrievals(), 1);
});

test("omits editor names when user information is unavailable", async () => {
  const notion = createNotionMock();
  let userRetrievals = 0;
  notion.users.retrieve = async () => {
    userRetrievals += 1;
    throw restrictedUserInformationError();
  };
  let warnings = 0;

  const pages = await discoverPages(notion, rootId, {
    onUserInfoUnavailable: () => {
      warnings += 1;
    },
  });

  assert.equal(pages[0].lastEditedBy, undefined);
  assert.equal(pages[1].lastEditedBy, undefined);
  assert.equal(warnings, 1);
  assert.equal(userRetrievals, 1);
});
