import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseBoolean,
  parseFilenameStrategy,
  parseRootPageIds,
  resolveOutputDirectory,
} from "../src/inputs";

test("parses and deduplicates Notion root page or database IDs and URLs", () => {
  const id = "8fe4a1b2123434567890abcdefabcdef";
  const secondId = "1234567890abcdef1234567890abcdef";
  assert.deepEqual(parseRootPageIds([
    id,
    "8fe4a1b2-1234-3456-7890-abcdefabcdef",
    `https://www.notion.so/Pricing-Governance-${id}?pvs=4`,
    secondId,
  ].join("\n")), [id, secondId]);
});

test("rejects malformed inputs", () => {
  assert.throws(() => parseRootPageIds(""), /at least one/);
  assert.throws(() => parseRootPageIds("not-a-page"), /Notion page or database URL or ID/);
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
