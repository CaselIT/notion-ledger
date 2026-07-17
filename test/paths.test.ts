import assert from "node:assert/strict";
import test from "node:test";
import {
  allocatePagePath,
  candidateFilename,
  slugTitle,
} from "../src/paths";

const page = {
  id: "8fe4a1b2123434567890abcdefabcdef",
  title: "Pricing & Governance!",
};

test("creates safe filenames for each strategy", () => {
  assert.equal(slugTitle(page.title), "pricing-and-governance");
  assert.equal(
    candidateFilename(page, "slug-and-id"),
    "pricing-and-governance--8fe4a1b2.md",
  );
  assert.equal(candidateFilename(page, "stable-id"), `${page.id}.md`);
  assert.equal(candidateFilename(page, "title"), "pricing-and-governance.md");
});

test("falls back to an ID suffix for duplicate titles", () => {
  const usedPaths = new Set(["pricing-and-governance.md"]);
  assert.equal(
    allocatePagePath(page, "title", usedPaths),
    "pricing-and-governance--8fe4a1b2.md",
  );
});
