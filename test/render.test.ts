import assert from "node:assert/strict";
import test from "node:test";
import type { Client } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import { parse } from "yaml";
import {
  configureInlineDatabaseRenderer,
  convertPage,
  GENERATED_MARKER,
  renderPage,
} from "../src/render";

const page = {
  id: "8fe4a1b2123434567890abcdefabcdef",
  url: "https://www.notion.so/Example-8fe4a1b2123434567890abcdefabcdef",
  title: "Pricing: \"Governance\"",
  lastEditedAt: "2026-07-17T09:30:00.000Z",
  lastEditedBy: "Federico Caselli",
};

test("renders safe front matter, marker, title, and body", () => {
  const content = renderPage(page, "- [ ] Review pricing\n  - [x] Check data", true);
  const frontmatter = content.split("---\n")[1];
  const parsed = parse(frontmatter);

  assert.equal(parsed.title, page.title);
  assert.equal(parsed.notion_page_id, page.id);
  assert.equal(parsed.last_edited_by, page.lastEditedBy);
  assert.match(content, new RegExp(GENERATED_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(content, /# Pricing: "Governance"/);
  assert.match(content, /- \[ \] Review pricing/);
  assert.equal(content.endsWith("\n"), true);
});

test("can omit front matter without omitting the generated marker", () => {
  const content = renderPage(page, "", false);
  assert.equal(content.startsWith(`${GENERATED_MARKER}\n\n# `), true);
  assert.doesNotMatch(content, /^---/);
});

test("converts nested Notion to-dos to GFM task lists", async () => {
  const parentTaskId = "11111111-1111-1111-1111-111111111111";
  const richText = (plainText: string) => [{
    type: "text",
    text: { content: plainText, link: null },
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: "default",
    },
    plain_text: plainText,
    href: null,
  }];
  const notionClient = {
    blocks: {
      children: {
        list: async ({ block_id: blockId }: { block_id: string }) => ({
          object: "list",
          type: "block",
          block: {},
          has_more: false,
          next_cursor: null,
          results: blockId === page.id
            ? [{
                id: parentTaskId,
                type: "to_do",
                has_children: true,
                to_do: { rich_text: richText("Review pricing assumptions"), checked: false },
              }]
            : [{
                id: "22222222-2222-2222-2222-222222222222",
                type: "to_do",
                has_children: false,
                to_do: { rich_text: richText("Check retailer data"), checked: true },
              }],
        }),
      },
    },
  } as unknown as Client;
  const n2m = new NotionToMarkdown({
    notionClient,
    config: { parseChildPages: false },
  });

  assert.equal(
    await convertPage(n2m, page.id),
    "- [ ] Review pricing assumptions\n    - [x] Check retailer data\n",
  );
});

test("converts an empty Notion page to an empty body", async () => {
  const notionClient = {
    blocks: {
      children: {
        list: async () => ({
          object: "list",
          type: "block",
          block: {},
          has_more: false,
          next_cursor: null,
          results: [],
        }),
      },
    },
  } as unknown as Client;
  const n2m = new NotionToMarkdown({
    notionClient,
    config: { parseChildPages: false },
  });

  assert.equal(await convertPage(n2m, page.id), "");
});

test("renders inline database rows as Markdown tasks", async () => {
  const firstRowId = "11111111-1111-1111-1111-111111111111";
  const secondRowId = "22222222-2222-2222-2222-222222222222";
  const thirdRowId = "33333333-3333-3333-3333-333333333333";
  const notion = {
    blocks: {
      children: {
        list: async () => ({
          object: "list",
          type: "block",
          block: {},
          has_more: false,
          next_cursor: null,
          results: [{
            id: "database-id",
            type: "child_database",
            child_database: { title: "Todo List" },
          }],
        }),
      },
    },
    databases: {
      retrieve: async () => ({
        object: "database",
        data_sources: [{ id: "data-source-id", name: "Todo List" }],
      }),
    },
    dataSources: {
      query: async () => ({
        results: [
          {
            id: firstRowId,
            properties: {
              Name: { type: "title", title: [{ plain_text: "Buy milk" }] },
              Done: { type: "checkbox", checkbox: true },
              Due: { type: "date", date: { start: "2026-07-20" } },
            },
          },
          {
            id: secondRowId,
            properties: {
              Name: { type: "title", title: [{ plain_text: "Book dentist" }] },
              Status: { type: "status", status: { name: "Not started" } },
            },
          },
          {
            id: thirdRowId,
            properties: {
              Name: { type: "title", title: [{ plain_text: "Send invoice" }] },
              Status: { type: "status", status: { name: "Done" } },
            },
          },
        ],
        has_more: false,
        next_cursor: null,
      }),
    },
  };
  const n2m = new NotionToMarkdown({
    notionClient: notion as unknown as Client,
    config: { parseChildPages: false },
  });
  configureInlineDatabaseRenderer(n2m, notion, "parent/page.md", {
    [firstRowId.replaceAll("-", "")]: "tasks/buy-milk.md",
    [secondRowId.replaceAll("-", "")]: "tasks/book-dentist.md",
    [thirdRowId.replaceAll("-", "")]: "tasks/send-invoice.md",
  });

  assert.equal(
    await convertPage(n2m, page.id),
    "\n## Todo List\n- [x] [Buy milk](../tasks/buy-milk.md) (Due: 2026-07-20)\n"
      + "- [ ] [Book dentist](../tasks/book-dentist.md)\n"
      + "- [x] [Send invoice](../tasks/send-invoice.md)\n\n",
  );
});
