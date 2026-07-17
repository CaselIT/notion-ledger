import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseBoolean,
  parseFilenameStrategy,
  parseRootPageId,
  resolveOutputDirectory,
} from "../src/inputs";

test("parses Notion IDs and URLs", () => {
  const id = "8fe4a1b2123434567890abcdefabcdef";
  assert.equal(parseRootPageId(id), id);
  assert.equal(
    parseRootPageId("8fe4a1b2-1234-3456-7890-abcdefabcdef"),
    id,
  );
  assert.equal(
    parseRootPageId(`https://www.notion.so/Pricing-Governance-${id}?pvs=4`),
    id,
  );
});

test("rejects malformed inputs", () => {
  assert.throws(() => parseRootPageId("not-a-page"), /Notion page URL or page ID/);
  assert.throws(() => parseBoolean("yes", "enabled"), /enabled must be/);
  assert.throws(() => parseFilenameStrategy("slug"), /filename-strategy/);
});

test("keeps output directories inside the workspace", () => {
  const workspace = path.join(os.tmpdir(), "notion-ledger-workspace");
  assert.equal(
    resolveOutputDirectory(workspace, "docs/notion"),
    path.join(workspace, "docs", "notion"),
  );
  assert.throws(
    () => resolveOutputDirectory(workspace, "../outside"),
    /inside the GitHub workspace/,
  );
  assert.throws(
    () => resolveOutputDirectory(workspace, path.resolve(workspace, "absolute")),
    /must be relative/,
  );
  assert.throws(
    () => resolveOutputDirectory(workspace, "."),
    /must not be the GitHub workspace root/,
  );
});
