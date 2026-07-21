import assert from "node:assert/strict";
import test from "node:test";
import { APIErrorCode, APIResponseError } from "@notionhq/client";
import {
  type DiscoveredPage,
  discoverPages,
  type DiscoverPagesOptions,
  findMarkdownReferences,
  queryInlineDatabaseRows,
} from "../src/notion";

const rootId = "11111111111111111111111111111111";
const childId = "22222222222222222222222222222222";
const databaseId = "33333333333333333333333333333333";
const unknownBlockId = "44444444444444444444444444444444";
const nestedUnknownBlockId = "55555555555555555555555555555555";
const aliasTargetId = "66666666666666666666666666666666";

async function collectPages(
  notion: Parameters<typeof discoverPages>[0],
  rootPageId: string,
  options: DiscoverPagesOptions = {},
): Promise<DiscoveredPage[]> {
  const pages: DiscoveredPage[] = [];
  await discoverPages(notion, rootPageId, {
    ...options,
    onPage: async (page, references) => {
      await options.onPage?.(page, references);
      pages.push(page);
    },
  });
  return pages;
}

function createNotionMock(): Parameters<typeof discoverPages>[0] & {
  userRetrievals: () => number;
  markdownRetrievals: () => string[];
} {
  let userRetrievals = 0;
  const markdownRetrievals: string[] = [];
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
    markdownRetrievals: () => markdownRetrievals,
    blocks: {
      retrieve: async () => ({ object: "block", type: "unsupported" }),
    },
    pages: {
      retrieve: async ({ page_id: pageId }: { page_id: string }) => pages[pageId],
      retrieveMarkdown: async ({ page_id: pageId }: { page_id: string }) => {
        markdownRetrievals.push(pageId);
        return {
          markdown: pageId === rootId
            ? `<details>\n<summary>Pages</summary>\n\t<page url="https://app.notion.com/p/${childId}">Child</page>\n</details>`
            : "",
          truncated: false,
          unknown_block_ids: [],
        };
      },
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

function missingUserInformationError(): APIResponseError {
  return new APIResponseError({
    code: APIErrorCode.ObjectNotFound,
    status: 404,
    message: "Could not find user.",
    headers: new Headers(),
    rawBodyText: "",
    additional_data: undefined,
    request_id: undefined,
  });
}

test("finds ordered page and database references in enhanced Markdown", () => {
  const markdown = [
    `<page url="https://app.notion.com/p/${childId}">Child</page>`,
    "```html",
    `<page url="https://app.notion.com/p/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">Example</page>`,
    "```",
    `\t<database inline="true" url="https://app.notion.com/p/${databaseId}">Tasks</database>`,
  ].join("\n");

  assert.deepEqual(findMarkdownReferences(markdown), [
    { type: "page", id: childId },
    { type: "database", id: databaseId },
  ]);
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

test("discovers inline database rows as child pages", async () => {
  const notion = createNotionMock();
  notion.pages.retrieveMarkdown = async ({ page_id: pageId }) => ({
    markdown: pageId === rootId
      ? `<database url="https://app.notion.com/p/${databaseId}" inline="true">Tasks</database>`
      : "",
    truncated: false,
    unknown_block_ids: [],
  });
  notion.databases.retrieve = async () => ({
    object: "database",
    data_sources: [{ id: "data-source-id", name: "Tasks" }],
  });
  notion.dataSources.query = async () => ({
    results: [{ object: "page", id: childId }],
    has_more: false,
    next_cursor: null,
  });

  assert.deepEqual(
    (await collectPages(notion, rootId)).map((page) => page.id),
    [rootId, childId],
  );
});

test("discovers root and descendant metadata", async () => {
  const notion = createNotionMock();
  const pages = await collectPages(notion, rootId);
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
  assert.deepEqual(notion.markdownRetrievals(), [rootId, childId]);
  assert.match(pages[0].markdown, /<page /);
});

test("streams each page through onPage in depth-first order", async () => {
  const streamed: string[] = [];
  await discoverPages(createNotionMock(), rootId, {
    onPage: (page) => {
      streamed.push(page.id);
    },
  });

  assert.deepEqual(streamed, [rootId, childId]);
});

test("uses cached references while retrieving Markdown only for changed descendants", async () => {
  const notion = createNotionMock();
  const pages = await collectPages(notion, rootId, {
    getCachedReferences: (page) => page.id === rootId
      ? [{ type: "page", id: childId }]
      : undefined,
  });

  assert.deepEqual(pages.map((page) => page.id), [childId]);
  assert.deepEqual(notion.markdownRetrievals(), [childId]);
  assert.equal(notion.userRetrievals(), 1);
});

test("queries inline databases found in cached references", async () => {
  const notion = createNotionMock();
  let databaseQueries = 0;
  notion.databases.retrieve = async () => ({
    object: "database",
    data_sources: [{ id: "data-source-id", name: "Tasks" }],
  });
  notion.dataSources.query = async () => {
    databaseQueries += 1;
    return {
      results: [{ object: "page", id: childId }],
      has_more: false,
      next_cursor: null,
    };
  };

  const pages = await collectPages(notion, rootId, {
    getCachedReferences: (page) => page.id === rootId
      ? [{ type: "database", id: databaseId }]
      : [],
  });

  assert.deepEqual(pages, []);
  assert.deepEqual(notion.markdownRetrievals(), []);
  assert.equal(databaseQueries, 1);
});

test("reports discovery progress when requested", async () => {
  const progress: string[] = [];

  await discoverPages(createNotionMock(), rootId, {
    onProgress: (message) => progress.push(message),
  });

  assert.ok(progress.includes(`Retrieving page metadata for ${rootId}.`));
  assert.ok(progress.includes(`Retrieving Markdown for "Root" (${rootId}).`));
  assert.ok(progress.includes(`Discovered 1 child page(s) below ${rootId}.`));
  assert.ok(progress.includes(`Retrieving page metadata for ${childId}.`));
});

test("retrieves and inserts truncated Markdown subtrees", async () => {
  const notion = createNotionMock();
  notion.pages.retrieveMarkdown = async ({ page_id: pageId }) => {
    if (pageId === rootId) {
      return {
        markdown: [
          "Before",
          `\t<unknown url=\"https://app.notion.com/p/${rootId}#${unknownBlockId}\" alt=\"toggle\"/>`,
          "After",
        ].join("\n"),
        truncated: true,
        unknown_block_ids: [unknownBlockId],
      };
    }
    if (pageId === unknownBlockId) {
      return {
        markdown: [
          "Recovered",
          `\t<page url=\"https://app.notion.com/p/${childId}\">Child</page>`,
        ].join("\n"),
        truncated: false,
        unknown_block_ids: [],
      };
    }
    return { markdown: "", truncated: false, unknown_block_ids: [] };
  };

  const progress: string[] = [];
  const pages = await collectPages(notion, rootId, {
    onProgress: (message) => progress.push(message),
  });

  assert.deepEqual(
    pages.map((page) => page.id),
    [rootId, childId],
  );
  assert.equal(
    pages[0].markdown,
    [
      "Before",
      "\tRecovered",
      `\t\t<page url=\"https://app.notion.com/p/${childId}\">Child</page>`,
      "After",
    ].join("\n"),
  );
  assert.ok(progress.includes(`Retrieving incomplete Markdown subtree ${unknownBlockId}.`));
});

test("recovers multiple recursively truncated subtrees in place", async () => {
  const notion = createNotionMock();
  notion.pages.retrieveMarkdown = async ({ page_id: pageId }) => {
    if (pageId === rootId) {
      return {
        markdown: [
          `<unknown url="https://app.notion.com/p/${rootId}#${unknownBlockId}"/>`,
          `<unknown url="https://app.notion.com/p/${rootId}#${nestedUnknownBlockId}"/>`,
        ].join("\n"),
        truncated: true,
        unknown_block_ids: [nestedUnknownBlockId, unknownBlockId],
      };
    }
    if (pageId === unknownBlockId) {
      return { markdown: "First\n", truncated: false, unknown_block_ids: [] };
    }
    if (pageId === nestedUnknownBlockId) {
      return {
        markdown: `Nested\n\t<unknown url="https://app.notion.com/p/${nestedUnknownBlockId}#${databaseId}"/>`,
        truncated: true,
        unknown_block_ids: [databaseId],
      };
    }
    if (pageId === databaseId) {
      return { markdown: "Recovered nested", truncated: false, unknown_block_ids: [] };
    }
    return { markdown: "", truncated: false, unknown_block_ids: [] };
  };

  const pages = await collectPages(notion, rootId);

  assert.equal(
    pages[0].markdown,
    ["First", "Nested", "\tRecovered nested"].join("\n"),
  );
});

test("preserves self-referential unknown subtrees", async () => {
  const notion = createNotionMock();
  const placeholder = `<unknown url="https://app.notion.com/p/${rootId}#${unknownBlockId}" alt="unsupported"/>`;
  notion.pages.retrieveMarkdown = async ({ page_id: pageId }) => ({
    markdown: pageId === rootId ? `Before\n${placeholder}\nAfter` : placeholder,
    truncated: true,
    unknown_block_ids: [unknownBlockId],
  });
  const unresolved: string[] = [];

  const pages = await collectPages(notion, rootId, {
    onUnknownBlockUnresolved: (blockId) => unresolved.push(blockId),
  });

  assert.equal(pages[0].markdown, `Before\n${placeholder}\nAfter`);
  assert.deepEqual(unresolved, [unknownBlockId]);
});

test("preserves inaccessible unknown subtrees", async () => {
  const notion = createNotionMock();
  const placeholder = `<unknown url="https://app.notion.com/p/${rootId}#${unknownBlockId}" alt="unsupported"/>`;
  notion.pages.retrieveMarkdown = async ({ page_id: pageId }) => {
    if (pageId === rootId) {
      return {
        markdown: `Before\n${placeholder}\nAfter`,
        truncated: true,
        unknown_block_ids: [unknownBlockId],
      };
    }
    throw new APIResponseError({
      code: APIErrorCode.ObjectNotFound,
      status: 404,
      message: "Could not find page.",
      headers: new Headers(),
      rawBodyText: "",
      additional_data: undefined,
      request_id: undefined,
    });
  };
  const unresolved: string[] = [];

  const pages = await collectPages(notion, rootId, {
    onUnknownBlockUnresolved: (blockId) => unresolved.push(blockId),
  });

  assert.equal(pages[0].markdown, `Before\n${placeholder}\nAfter`);
  assert.deepEqual(unresolved, [unknownBlockId]);
});

test("renders page aliases outside the current root without traversing them", async () => {
  const notion = createNotionMock();
  const placeholder = `<unknown url="https://app.notion.com/p/${rootId}#${unknownBlockId}" alt="alias"/>`;
  notion.pages.retrieveMarkdown = async ({ page_id: pageId }) => {
    notion.markdownRetrievals().push(pageId);
    return {
      markdown: placeholder,
      truncated: true,
      unknown_block_ids: [unknownBlockId],
    };
  };
  const retrievePage = notion.pages.retrieve;
  notion.pages.retrieve = async ({ page_id: pageId }) => pageId === aliasTargetId
    ? {
      object: "page",
      id: aliasTargetId,
      url: `https://notion.so/P-L-Configuration-${aliasTargetId}`,
      last_edited_time: "2026-07-17T10:00:00.000Z",
      properties: {
        title: { type: "title", title: [{ plain_text: "P&L Configuration" }] },
      },
    }
    : retrievePage({ page_id: pageId });
  notion.blocks.retrieve = async ({ block_id: blockId }) => ({
    object: "block",
    id: blockId,
    type: "link_to_page",
    link_to_page: { type: "page_id", page_id: aliasTargetId },
  });

  const pages = await collectPages(notion, rootId);

  assert.deepEqual(pages.map((page) => page.id), [rootId]);
  assert.equal(
    pages[0].markdown,
    `<page url="https://notion.so/P-L-Configuration-${aliasTargetId}" outside-current-root="true">P&amp;L Configuration (outside current root)</page>`,
  );
  assert.deepEqual(notion.markdownRetrievals(), [rootId, unknownBlockId]);
});

test("retains editor IDs when user information is unavailable", async () => {
  const notion = createNotionMock();
  let userRetrievals = 0;
  notion.users.retrieve = async () => {
    userRetrievals += 1;
    throw restrictedUserInformationError();
  };
  let warnings = 0;

  const pages = await collectPages(notion, rootId, {
    onUserInfoUnavailable: () => {
      warnings += 1;
    },
  });

  assert.equal(pages[0].lastEditedBy, "editor");
  assert.equal(pages[1].lastEditedBy, "editor");
  assert.equal(warnings, 1);
  assert.equal(userRetrievals, 1);
});

test("retains editor IDs when Notion cannot find a user", async () => {
  const notion = createNotionMock();
  notion.users.retrieve = async () => {
    throw missingUserInformationError();
  };

  const pages = await collectPages(notion, rootId);

  assert.equal(pages[0].lastEditedBy, "editor");
  assert.equal(pages[1].lastEditedBy, "editor");
});
