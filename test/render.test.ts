import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";
import {
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

test("preserves enhanced Markdown tags in the generated body", () => {
  const markdown = "<page url=\"https://app.notion.com/p/child\">Child</page>";
  assert.match(renderPage(page, markdown, false), new RegExp(markdown));
});
