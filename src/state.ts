import fs from "node:fs/promises";
import path from "node:path";
import type { FilenameStrategy } from "./inputs";
import type { PageMetadata } from "./notion";
import { allocatePagePath, resolveIndexedPath } from "./paths";

export const INDEX_FILENAME = ".mirror-index.json";
const INDEX_VERSION = 1;

interface MirrorIndexEntry {
  path: string;
  title: string;
  last_edited_at?: string;
}

interface MirrorIndex {
  version: number;
  root_page_id: string;
  pages: Record<string, MirrorIndexEntry>;
}

interface RenderedPage {
  page: PageMetadata;
  content: string;
}

interface ReconcileOptions {
  outputDir: string;
  rootPageId: string;
  renderedPages: RenderedPage[];
  pagePaths?: Record<string, string>;
  filenameStrategy: FilenameStrategy;
  deleteOrphans: boolean;
}

export interface ReconcileResult {
  pagesExported: number;
  pagesChanged: number;
  pagesDeleted: number;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

export function emptyIndex(rootPageId: string): MirrorIndex {
  return {
    version: INDEX_VERSION,
    root_page_id: rootPageId,
    pages: {},
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function parseIndex(value: unknown, indexPath: string, rootPageId: string): MirrorIndex {
  if (
    typeof value !== "object"
    || value === null
    || !("version" in value)
    || !("root_page_id" in value)
    || !("pages" in value)
    || value.version !== INDEX_VERSION
    || value.root_page_id !== rootPageId
    || typeof value.pages !== "object"
    || value.pages === null
    || Array.isArray(value.pages)
  ) {
    throw new Error(
      `Mirror index is incompatible or belongs to a different root page: ${indexPath}. `
      + "Use a separate output-dir or remove the existing index deliberately.",
    );
  }

  for (const entry of Object.values(value.pages)) {
    if (
      typeof entry !== "object"
      || entry === null
      || !("path" in entry)
      || typeof entry.path !== "string"
      || !("title" in entry)
      || typeof entry.title !== "string"
    ) {
      throw new Error("Mirror index contains an invalid page entry.");
    }
  }
  return value as MirrorIndex;
}

export async function readIndex(
  outputDir: string,
  rootPageId: string,
): Promise<MirrorIndex> {
  const indexPath = path.join(outputDir, INDEX_FILENAME);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(indexPath, "utf8")) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return emptyIndex(rootPageId);
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Mirror index is not valid JSON: ${indexPath}`);
    }
    throw error;
  }

  const index = parseIndex(parsed, indexPath, rootPageId);
  for (const entry of Object.values(index.pages)) {
    resolveIndexedPath(outputDir, entry.path);
  }
  return index;
}

export async function writeIfChanged(
  filePath: string,
  content: string,
): Promise<boolean> {
  try {
    if (await fs.readFile(filePath, "utf8") === content) {
      return false;
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  return true;
}

export function serializeIndex(index: MirrorIndex): string {
  const pages = Object.fromEntries(
    Object.entries(index.pages).sort(([left], [right]) => left.localeCompare(right)),
  );
  return `${JSON.stringify({ ...index, pages }, null, 2)}\n`;
}

export async function planPagePaths(
  outputDir: string,
  rootPageId: string,
  pages: PageMetadata[],
  filenameStrategy: FilenameStrategy,
): Promise<Record<string, string>> {
  const previous = await readIndex(outputDir, rootPageId);
  const usedPaths = new Set(
    Object.values(previous.pages).map((entry) => entry.path.toLowerCase()),
  );
  const pagePaths: Record<string, string> = {};
  for (const page of [...pages].sort((left, right) => left.id.localeCompare(right.id))) {
    pagePaths[page.id] = previous.pages[page.id]?.path
      ?? allocatePagePath(page, filenameStrategy, usedPaths);
  }
  return pagePaths;
}

export async function reconcileMirror({
  outputDir,
  rootPageId,
  renderedPages,
  pagePaths,
  filenameStrategy,
  deleteOrphans,
}: ReconcileOptions): Promise<ReconcileResult> {
  await fs.mkdir(outputDir, { recursive: true });
  const previous = await readIndex(outputDir, rootPageId);
  const next = emptyIndex(rootPageId);
  const usedPaths = new Set(
    Object.values(previous.pages).map((entry) => entry.path.toLowerCase()),
  );
  let pagesChanged = 0;
  let pagesDeleted = 0;

  for (const { page, content } of [...renderedPages].sort(
    (left, right) => left.page.id.localeCompare(right.page.id),
  )) {
    const pagePath = pagePaths?.[page.id]
      ?? previous.pages[page.id]?.path
      ?? allocatePagePath(page, filenameStrategy, usedPaths);
    if (previous.pages[page.id] && previous.pages[page.id].path !== pagePath) {
      throw new Error(`Planned path does not preserve the indexed path for page ${page.id}.`);
    }
    const targetPath = resolveIndexedPath(outputDir, pagePath);
    if (await writeIfChanged(targetPath, content)) {
      pagesChanged += 1;
    }
    next.pages[page.id] = {
      path: pagePath,
      title: page.title,
      last_edited_at: page.lastEditedAt,
    };
  }

  for (const [pageId, entry] of Object.entries(previous.pages)) {
    if (next.pages[pageId]) {
      continue;
    }
    if (!deleteOrphans) {
      next.pages[pageId] = entry;
      continue;
    }

    const orphanPath = resolveIndexedPath(outputDir, entry.path);
    if (await pathExists(orphanPath)) {
      await fs.rm(orphanPath);
      pagesDeleted += 1;
    }
  }

  await writeIfChanged(path.join(outputDir, INDEX_FILENAME), serializeIndex(next));
  return {
    pagesExported: renderedPages.length,
    pagesChanged,
    pagesDeleted,
  };
}
