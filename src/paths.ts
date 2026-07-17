import path from "node:path";
import slugify from "slugify";
import type { FilenameStrategy } from "./inputs";

export interface PagePathMetadata {
  id: string;
  title: string;
}

export function slugTitle(title: string): string {
  return slugify(title, {
    lower: true,
    strict: true,
    trim: true,
  }) || "untitled";
}

export function candidateFilename(
  page: PagePathMetadata,
  strategy: FilenameStrategy,
): string {
  if (strategy === "stable-id") {
    return `${page.id}.md`;
  }

  const slug = slugTitle(page.title);
  if (strategy === "title") {
    return `${slug}.md`;
  }
  return `${slug}--${page.id.slice(0, 8)}.md`;
}

export function allocatePagePath(
  page: PagePathMetadata,
  strategy: FilenameStrategy,
  usedPaths: Set<string>,
): string {
  let candidate = candidateFilename(page, strategy);
  if (usedPaths.has(candidate.toLowerCase())) {
    const extension = path.posix.extname(candidate);
    const basename = candidate.slice(0, -extension.length);
    candidate = `${basename}--${page.id.slice(0, 8)}${extension}`;
  }
  if (usedPaths.has(candidate.toLowerCase())) {
    candidate = `${page.id}.md`;
  }
  if (usedPaths.has(candidate.toLowerCase())) {
    throw new Error(`Unable to allocate a unique output path for Notion page ${page.id}.`);
  }
  usedPaths.add(candidate.toLowerCase());
  return candidate;
}

export function resolveIndexedPath(outputDir: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`Mirror index contains an unsafe path: ${relativePath || "<empty>"}.`);
  }
  const resolved = path.resolve(outputDir, relativePath);
  const relative = path.relative(path.resolve(outputDir), resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Mirror index path escapes output-dir: ${relativePath}.`);
  }
  return resolved;
}
