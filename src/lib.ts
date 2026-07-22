import path from "node:path";
import { Client } from "@notionhq/client";
import type { FilenameStrategy } from "./inputs";
import { discoverPages } from "./notion";
import { renderPage } from "./render";
import {
  beginIncrementalMirror,
  type IncrementalMirrorWriter,
  planRootPaths,
} from "./state";

export type LogLevel = "debug" | "info" | "warn";

export type MirrorLogger = Record<LogLevel, (message: string) => void>;

export interface MirrorOptions {
  notionToken: string;
  rootPageIds: string[];
  outputDir: string;
  addFrontmatter: boolean;
  deleteOrphans: boolean;
  fullExport: boolean;
  filenameStrategy: FilenameStrategy;
  logger: MirrorLogger;
}

export interface MirrorResult {
  rootsMirrored: number;
  pagesExported: number;
  pagesChanged: number;
  pagesDeleted: number;
}

export async function runMirror(options: MirrorOptions): Promise<MirrorResult> {
  const {
    notionToken,
    rootPageIds,
    outputDir,
    addFrontmatter,
    deleteOrphans,
    fullExport,
    filenameStrategy,
    logger,
  } = options;
  const notion = new Client({ auth: notionToken });

  let pagesExported = 0;
  let pagesChanged = 0;
  let pagesDeleted = 0;
  let warnedAboutUserInfo = false;
  const warnedUnknownBlocks = new Set<string>();

  // Track the writer for the root currently being mirrored so its progress can
  // be saved if the run fails or is interrupted before reconciliation finishes.
  let activeWriter: IncrementalMirrorWriter | undefined;
  const saveProgress = async (): Promise<void> => {
    try {
      await activeWriter?.persist();
    } catch (error: unknown) {
      logger.warn(
        `Could not save mirror index progress: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  let interrupted = false;
  const handleSignal = (signal: NodeJS.Signals): void => {
    if (interrupted) {
      return;
    }
    interrupted = true;
    void (async () => {
      logger.warn(`Received ${signal}; saving mirror index progress before exiting.`);
      await saveProgress();
      process.exit(130);
    })();
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  try {
    for (const rootPageId of rootPageIds) {
      logger.info(`Discovering pages below Notion root ${rootPageId}.`);
      let writer: IncrementalMirrorWriter | undefined;
      const ensureWriter = async (page: Parameters<IncrementalMirrorWriter["reusePage"]>[0]) => {
        if (writer) {
          return writer;
        }
        if (page.id !== rootPageId) {
          throw new Error(`Notion root ${rootPageId} was not discovered first.`);
        }
        const rootPaths = await planRootPaths(outputDir, [page]);
        writer = await beginIncrementalMirror({
          outputDir: path.join(outputDir, rootPaths[rootPageId]),
          rootPageId,
          filenameStrategy,
          deleteOrphans,
        });
        activeWriter = writer;
        return writer;
      };
      await discoverPages(notion, rootPageId, {
        onProgress: logger.debug,
        onRoot: async (root) => {
          await ensureWriter(root);
        },
        getCachedReferences: async (page) => {
          const currentWriter = await ensureWriter(page);
          return fullExport ? undefined : currentWriter.reusePage(page);
        },
        onPage: async (page, references) => {
          const currentWriter = await ensureWriter(page);
          await currentWriter.writePage({
            page,
            content: renderPage(page, page.markdown, addFrontmatter),
            references,
          });
        },
        onUnknownBlockUnresolved: (blockId) => {
          if (!warnedUnknownBlocks.has(blockId)) {
            warnedUnknownBlocks.add(blockId);
            logger.warn(
              `Notion could not resolve Markdown block ${blockId}; `
              + "preserving its <unknown> placeholder.",
            );
          }
        },
        onUserInfoUnavailable: () => {
          if (!warnedAboutUserInfo) {
            warnedAboutUserInfo = true;
            logger.warn(
              "Using Notion editor IDs for last_edited_by because the integration does not have "
              + "User information without email addresses capability.",
            );
          }
        },
      });
      if (!writer) {
        throw new Error(`Notion root ${rootPageId} was not discovered.`);
      }
      const result = await writer.finish();
      activeWriter = undefined;
      pagesExported += result.pagesExported;
      pagesChanged += result.pagesChanged;
      pagesDeleted += result.pagesDeleted;
    }
  } catch (error: unknown) {
    // Save whatever was successfully exported before the failure, without
    // deleting orphans, so the next run can resume from partial progress.
    await saveProgress();
    throw error;
  } finally {
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
  }

  const result = {
    rootsMirrored: rootPageIds.length,
    pagesExported,
    pagesChanged,
    pagesDeleted,
  };
  logger.info(
    `Exported ${pagesExported} page(s) from ${rootPageIds.length} root(s); `
    + `changed ${pagesChanged}; deleted ${pagesDeleted}.`,
  );
  return result;
}