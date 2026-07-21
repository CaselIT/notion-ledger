import fs from "node:fs/promises";
import path from "node:path";
import type { FilenameStrategy } from "./inputs";
import type { MarkdownReference, PageMetadata } from "./notion";
import { allocatePagePath, resolveIndexedPath, slugTitle } from "./paths";

export const INDEX_FILENAME = ".mirror-index.json";
export const ROOTS_INDEX_FILENAME = ".mirror-roots.json";
const INDEX_VERSION = 1;

interface MirrorIndexEntry {
  path: string;
  title: string;
  last_edited_at?: string;
  references?: MarkdownReference[];
}

interface MirrorIndex {
  version: number;
  root_page_id: string;
  pages: Record<string, MirrorIndexEntry>;
}

interface RootIndex {
  version: number;
  roots: Record<string, { path: string; title: string }>;
}

interface RenderedPage {
  page: PageMetadata;
  content: string;
  references: MarkdownReference[];
}

interface IncrementalMirrorOptions {
  outputDir: string;
  rootPageId: string;
  filenameStrategy: FilenameStrategy;
  deleteOrphans: boolean;
}

export interface IncrementalMirrorWriter {
  reusePage(page: PageMetadata): Promise<MarkdownReference[] | undefined>;
  writePage(renderedPage: RenderedPage): Promise<boolean>;
  persist(): Promise<void>;
  finish(): Promise<ReconcileResult>;
}

export interface ReconcileResult {
  pagesExported: number;
  pagesChanged: number;
  pagesDeleted: number;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
      || ("last_edited_at" in entry && typeof entry.last_edited_at !== "string")
      || (
        "references" in entry
        && (
          !Array.isArray(entry.references)
          || entry.references.some((reference: unknown) => (
            !isRecord(reference)
            || (reference.type !== "page" && reference.type !== "database")
            || typeof reference.id !== "string"
            || !/^[0-9a-f]{32}$/.test(reference.id)
          ))
        )
      )
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

export async function planRootPaths(
  outputDir: string,
  roots: PageMetadata[],
): Promise<Record<string, string>> {
  await fs.mkdir(outputDir, { recursive: true });
  const indexPath = path.join(outputDir, ROOTS_INDEX_FILENAME);
  let index: RootIndex = { version: INDEX_VERSION, roots: {} };
  try {
    const parsed = JSON.parse(await fs.readFile(indexPath, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.version !== INDEX_VERSION || !isRecord(parsed.roots)) {
      throw new Error(`Root index is incompatible: ${indexPath}.`);
    }
    for (const entry of Object.values(parsed.roots)) {
      if (!isRecord(entry) || typeof entry.path !== "string"
        || typeof entry.title !== "string" || entry.path === "."
        || path.dirname(entry.path) !== ".") {
        throw new Error(`Root index contains an invalid entry: ${indexPath}.`);
      }
      resolveIndexedPath(outputDir, entry.path);
    }
    index = parsed as unknown as RootIndex;
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      if (error instanceof SyntaxError) {
        throw new Error(`Root index is not valid JSON: ${indexPath}.`);
      }
      throw error;
    }
  }

  const usedPaths = new Set(
    Object.values(index.roots).map((entry) => entry.path.toLowerCase()),
  );
  const rootPaths: Record<string, string> = {};
  for (const root of roots) {
    let rootPath = index.roots[root.id]?.path;
    if (!rootPath) {
      rootPath = `${slugTitle(root.title)}--${root.id.slice(0, 8)}`;
      if (usedPaths.has(rootPath.toLowerCase())) {
        rootPath = `${slugTitle(root.title)}--${root.id}`;
      }
      if (usedPaths.has(rootPath.toLowerCase())) {
        throw new Error(`Unable to allocate a unique output directory for root ${root.id}.`);
      }
      usedPaths.add(rootPath.toLowerCase());
    }
    rootPaths[root.id] = rootPath;
    index.roots[root.id] = { path: rootPath, title: root.title };
  }
  const sortedRoots = Object.fromEntries(
    Object.entries(index.roots).sort(([left], [right]) => left.localeCompare(right)),
  );
  await writeIfChanged(indexPath, `${JSON.stringify({ ...index, roots: sortedRoots }, null, 2)}\n`);
  return rootPaths;
}

export async function beginIncrementalMirror({
  outputDir,
  rootPageId,
  filenameStrategy,
  deleteOrphans,
}: IncrementalMirrorOptions): Promise<IncrementalMirrorWriter> {
  await fs.mkdir(outputDir, { recursive: true });
  const index = await readIndex(outputDir, rootPageId);
  const usedPaths = new Set(
    Object.values(index.pages).map((entry) => entry.path.toLowerCase()),
  );
  const seen = new Set<string>();
  let pagesExported = 0;
  let pagesChanged = 0;
  let finished = false;

  return {
    async reusePage(page): Promise<MarkdownReference[] | undefined> {
      if (finished) {
        throw new Error("Cannot reuse a page after mirror reconciliation is complete.");
      }
      const entry = index.pages[page.id];
      if (
        !entry
        || entry.last_edited_at !== page.lastEditedAt
        || !entry.references
        || !await pathExists(resolveIndexedPath(outputDir, entry.path))
      ) {
        return undefined;
      }
      entry.title = page.title;
      seen.add(page.id);
      pagesExported += 1;
      return entry.references.map((reference) => ({ ...reference }));
    },

    async writePage({ page, content, references }): Promise<boolean> {
      if (finished) {
        throw new Error("Cannot write a page after mirror reconciliation is complete.");
      }
      const pagePath = index.pages[page.id]?.path
        ?? allocatePagePath(page, filenameStrategy, usedPaths);
      const targetPath = resolveIndexedPath(outputDir, pagePath);
      const changed = await writeIfChanged(targetPath, content);
      index.pages[page.id] = {
        path: pagePath,
        title: page.title,
        last_edited_at: page.lastEditedAt,
        references,
      };
      seen.add(page.id);
      pagesExported += 1;
      if (changed) {
        pagesChanged += 1;
      }
      return changed;
    },

    async persist(): Promise<void> {
      await writeIfChanged(path.join(outputDir, INDEX_FILENAME), serializeIndex(index));
    },

    async finish(): Promise<ReconcileResult> {
      if (finished) {
        throw new Error("Mirror reconciliation is already complete.");
      }
      finished = true;
      let pagesDeleted = 0;
      for (const [pageId, entry] of Object.entries(index.pages)) {
        if (seen.has(pageId) || !deleteOrphans) {
          continue;
        }
        const orphanPath = resolveIndexedPath(outputDir, entry.path);
        if (await pathExists(orphanPath)) {
          await fs.rm(orphanPath);
          pagesDeleted += 1;
        }
        delete index.pages[pageId];
      }
      await writeIfChanged(path.join(outputDir, INDEX_FILENAME), serializeIndex(index));
      return { pagesExported, pagesChanged, pagesDeleted };
    },
  };
}
