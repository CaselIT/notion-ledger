import { APIErrorCode, APIResponseError } from "@notionhq/client";
import { normalizePageId } from "./inputs";

// Notion enhanced Markdown embeds page/block IDs as either a 32-character
// compact form or a hyphenated UUID; this alternation matches both.
const PAGE_ID = "[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

interface PageResponse {
  id: string;
  url: string;
  last_edited_time: string;
  last_edited_by?: unknown;
  properties: Record<string, unknown>;
}

export interface PageMarkdownResponse {
  markdown: string;
  truncated: boolean;
  unknown_block_ids: string[];
}

export interface NotionClient {
  blocks: {
    retrieve: (parameters: { block_id: string }) => Promise<unknown>;
  };
  pages: {
    retrieve: (parameters: { page_id: string }) => Promise<unknown>;
    retrieveMarkdown: (parameters: { page_id: string }) => Promise<PageMarkdownResponse>;
  };
  databases: {
    retrieve: (parameters: { database_id: string }) => Promise<unknown>;
  };
  dataSources: {
    query: (parameters: {
      data_source_id: string;
      page_size: number;
      start_cursor?: string;
    }) => Promise<{
      results: unknown[];
      has_more: boolean;
      next_cursor: string | null;
    }>;
  };
  users: {
    retrieve: (parameters: { user_id: string }) => Promise<unknown>;
  };
}

export interface PageMetadata {
  id: string;
  url: string;
  title: string;
  lastEditedAt: string;
  lastEditedBy?: string;
}

export interface DiscoveredPage extends PageMetadata {
  markdown: string;
}

export interface MarkdownReference {
  type: "page" | "database";
  id: string;
}

export interface DiscoverPagesOptions {
  getCachedReferences?: (
    page: PageMetadata,
  ) => Promise<MarkdownReference[] | undefined> | MarkdownReference[] | undefined;
  onPage?: (
    page: DiscoveredPage,
    references: MarkdownReference[],
  ) => Promise<void> | void;
  onUnknownBlockUnresolved?: (blockId: string) => void;
  onUserInfoUnavailable?: () => void;
  onProgress?: (message: string) => void;
}

function replaceUnknownBlock(
  markdown: string,
  blockId: string,
  replacement: string,
): string {
  const lines = markdown.split("\n");
  const normalizedBlockId = normalizePageId(blockId);
  let fallbackIndex: number | undefined;
  let replacementIndex: number | undefined;
  let indentation = "";

  for (let index = 0; index < lines.length; index += 1) {
    const placeholder = lines[index].match(/^([\t ]*)<unknown\b([^>]*)\/>[\t ]*$/);
    if (!placeholder) {
      continue;
    }
    fallbackIndex ??= index;
    const url = placeholder[2].match(/\burl="([^"]+)"/)?.[1];
    const ids = url
      ? Array.from(url.matchAll(new RegExp(`(${PAGE_ID})(?=[^0-9a-f]|$)`, "gi")))
      : [];
    const id = ids.at(-1)?.[1];
    if (id && normalizePageId(id) === normalizedBlockId) {
      replacementIndex = index;
      indentation = placeholder[1];
      break;
    }
  }

  replacementIndex ??= fallbackIndex;
  if (replacementIndex === undefined) {
    throw new Error(`Notion Markdown has no placeholder for unknown block ${normalizedBlockId}.`);
  }
  if (!indentation) {
    indentation = lines[replacementIndex].match(/^([\t ]*)/)?.[1] ?? "";
  }
  const replacementLines = replacement.replace(/\n$/, "").split("\n").map(
    (line) => line ? `${indentation}${line}` : line,
  );
  lines.splice(replacementIndex, 1, ...replacementLines);
  return lines.join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function resolvePageAlias(
  notion: Pick<NotionClient, "blocks" | "pages">,
  blockId: string,
): Promise<string | undefined> {
  const block = await notion.blocks.retrieve({ block_id: blockId });
  if (
    !isRecord(block)
    || block.type !== "link_to_page"
    || !isRecord(block.link_to_page)
    || block.link_to_page.type !== "page_id"
    || typeof block.link_to_page.page_id !== "string"
  ) {
    return undefined;
  }

  const target = toPageMetadata(await notion.pages.retrieve({
    page_id: normalizePageId(block.link_to_page.page_id),
  }));
  return `<page url="${escapeHtml(target.url)}" outside-current-root="true">${escapeHtml(target.title)} (outside current root)</page>`;
}

async function retrieveCompleteMarkdown(
  notion: Pick<NotionClient, "blocks" | "pages">,
  pageOrBlockId: string,
  onProgress?: (message: string) => void,
  onUnknownBlockUnresolved?: (blockId: string) => void,
  ancestors = new Set<string>(),
): Promise<string> {
  const normalizedId = normalizePageId(pageOrBlockId);
  if (ancestors.has(normalizedId)) {
    throw new Error(`Notion returned a cyclic unknown block reference for ${normalizedId}.`);
  }
  ancestors.add(normalizedId);
  try {
    const response = await notion.pages.retrieveMarkdown({ page_id: normalizedId });
    if (!response.truncated) {
      return response.markdown;
    }
    if (response.unknown_block_ids.length === 0) {
      throw new Error(
        `Notion returned incomplete Markdown for ${normalizedId} without retrievable block IDs.`,
      );
    }

    let markdown = response.markdown;
    for (const unknownBlockId of response.unknown_block_ids) {
      const normalizedBlockId = normalizePageId(unknownBlockId);
      if (ancestors.has(normalizedBlockId)) {
        const alias = await resolvePageAlias(notion, normalizedBlockId).catch(() => undefined);
        if (alias) {
          markdown = replaceUnknownBlock(markdown, normalizedBlockId, alias);
          continue;
        }
        onUnknownBlockUnresolved?.(normalizedBlockId);
        continue;
      }
      onProgress?.(`Retrieving incomplete Markdown subtree ${normalizedBlockId}.`);
      const subtree = await retrieveCompleteMarkdown(
        notion,
        normalizedBlockId,
        onProgress,
        onUnknownBlockUnresolved,
        ancestors,
      ).catch((error: unknown) => {
        if (
          APIResponseError.isAPIResponseError(error)
          && error.code === APIErrorCode.ObjectNotFound
        ) {
          onUnknownBlockUnresolved?.(normalizedBlockId);
          return undefined;
        }
        throw error;
      });
      if (subtree === undefined) {
        continue;
      }
      markdown = replaceUnknownBlock(markdown, normalizedBlockId, subtree);
    }
    return markdown;
  } finally {
    ancestors.delete(normalizedId);
  }
}

export function findMarkdownReferences(markdown: string): MarkdownReference[] {
  const references: MarkdownReference[] = [];
  let fence: { character: string; length: number } | undefined;
  for (const line of markdown.split("\n")) {
    const fenceMarker = line.match(/^[\t ]*(`{3,}|~{3,})/)?.[1];
    if (fenceMarker) {
      if (!fence) {
        fence = { character: fenceMarker[0], length: fenceMarker.length };
      } else if (fenceMarker[0] === fence.character && fenceMarker.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (fence) {
      continue;
    }
    const tag = line.match(/^[\t ]*<(page|database)\b([^>]*)>/);
    const url = tag?.[2].match(/\burl="([^"]+)"/)?.[1];
    if (!tag || !url) {
      continue;
    }
    if (/\boutside-current-root="true"/.test(tag[2])) {
      continue;
    }
    const id = url.match(new RegExp(`(${PAGE_ID})(?:[^0-9a-f]|$)`, "i"))?.[1];
    if (!id) {
      throw new Error(`Notion Markdown ${tag[1]} reference has no page ID: ${url}`);
    }
    references.push({ type: tag[1] as MarkdownReference["type"], id: normalizePageId(id) });
  }
  return references;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getDataSourceId(database: unknown): string {
  if (!isRecord(database) || !Array.isArray(database.data_sources)) {
    throw new Error("Notion returned invalid inline database metadata.");
  }
  const dataSource = database.data_sources.find(
    (candidate) => isRecord(candidate) && typeof candidate.id === "string",
  );
  if (!dataSource || typeof dataSource.id !== "string") {
    throw new Error("The inline Notion database has no queryable data source.");
  }
  return dataSource.id;
}

export async function queryInlineDatabaseRows(
  notion: Pick<NotionClient, "databases" | "dataSources">,
  databaseId: string,
  onProgress?: (message: string) => void,
): Promise<unknown[]> {
  onProgress?.(`Retrieving inline database metadata for ${databaseId}.`);
  const database = await notion.databases.retrieve({ database_id: databaseId });
  const dataSourceId = getDataSourceId(database);
  const rows: unknown[] = [];
  let cursor: string | undefined;
  let batch = 1;
  do {
    onProgress?.(`Querying inline database ${databaseId} (batch ${batch}).`);
    const response = await notion.dataSources.query({
      data_source_id: dataSourceId,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    rows.push(...response.results);
    onProgress?.(`Received ${response.results.length} row(s) from inline database ${databaseId}.`);
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
    batch += 1;
  } while (cursor);

  return rows;
}

function requirePageResponse(value: unknown): PageResponse {
  if (
    !isRecord(value)
    || typeof value.id !== "string"
    || typeof value.url !== "string"
    || typeof value.last_edited_time !== "string"
    || !isRecord(value.properties)
  ) {
    throw new Error("Notion returned partial or invalid page metadata.");
  }
  return value as unknown as PageResponse;
}

export function getPageTitle(page: PageResponse): string {
  const titleProperty = Object.values(page.properties ?? {}).find(
    (property) => isRecord(property) && property.type === "title",
  );
  const title = isRecord(titleProperty) && Array.isArray(titleProperty.title)
    ? titleProperty.title
      .filter((part): part is Record<string, unknown> => isRecord(part))
      .map((part) => typeof part.plain_text === "string" ? part.plain_text : "")
    .join("")
    .trim()
    : "";
  return title || "Untitled";
}

export function toPageMetadata(value: unknown): PageMetadata {
  const page = requirePageResponse(value);
  const lastEditedBy = isRecord(page.last_edited_by)
    && typeof page.last_edited_by.name === "string"
    ? page.last_edited_by.name || undefined
    : undefined;
  return {
    id: normalizePageId(page.id),
    url: page.url,
    title: getPageTitle(page),
    lastEditedAt: page.last_edited_time,
    lastEditedBy,
  };
}

function getLastEditedById(value: unknown): string | undefined {
  const page = requirePageResponse(value);
  return isRecord(page.last_edited_by) && typeof page.last_edited_by.id === "string"
    ? page.last_edited_by.id
    : undefined;
}

async function retrieveUserName(
  notion: NotionClient,
  userId: string,
): Promise<string | undefined> {
  const user = await notion.users.retrieve({ user_id: userId });
  return isRecord(user) && typeof user.name === "string"
    ? user.name || undefined
    : undefined;
}

export async function discoverPages(
  notion: NotionClient,
  rootPageId: string,
  {
    getCachedReferences,
    onPage,
    onUnknownBlockUnresolved,
    onUserInfoUnavailable,
    onProgress,
  }: DiscoverPagesOptions = {},
): Promise<void> {
  const visited = new Set();
  const userNames = new Map<string, Promise<string | undefined>>();
  let userInfoAvailable = true;

  async function visit(pageId: string): Promise<void> {
    const normalizedId = normalizePageId(pageId);
    if (visited.has(normalizedId)) {
      return;
    }
    visited.add(normalizedId);

    onProgress?.(`Retrieving page metadata for ${normalizedId}.`);
    const page = await notion.pages.retrieve({ page_id: normalizedId });
    const metadata = toPageMetadata(page);
    let references = await getCachedReferences?.(metadata);
    if (references === undefined) {
      const lastEditedById = getLastEditedById(page);
      if (!metadata.lastEditedBy && lastEditedById) {
        if (!userInfoAvailable) {
          metadata.lastEditedBy = lastEditedById;
        } else {
          const name = userNames.get(lastEditedById) ?? retrieveUserName(
            notion,
            lastEditedById,
          ).catch((error: unknown) => {
            if (
              APIResponseError.isAPIResponseError(error)
              && (
                error.code === APIErrorCode.RestrictedResource
                || error.code === APIErrorCode.ObjectNotFound
              )
            ) {
              if (error.code === APIErrorCode.RestrictedResource) {
                userInfoAvailable = false;
                onUserInfoUnavailable?.();
              }
              return undefined;
            }
            throw error;
          });
          userNames.set(lastEditedById, name);
          metadata.lastEditedBy = await name ?? lastEditedById;
        }
      }
      onProgress?.(`Retrieving Markdown for "${metadata.title}" (${normalizedId}).`);
      const markdown = await retrieveCompleteMarkdown(
        notion,
        normalizedId,
        onProgress,
        onUnknownBlockUnresolved,
      );
      references = findMarkdownReferences(markdown);
      await onPage?.({ ...metadata, markdown }, references);
    } else {
      onProgress?.(`Using cached Markdown references for "${metadata.title}" (${normalizedId}).`);
    }

    const childIds: string[] = [];
    for (const reference of references) {
      if (reference.type === "page") {
        childIds.push(reference.id);
        continue;
      }
      const rows = await queryInlineDatabaseRows(notion, reference.id, onProgress);
      for (const row of rows) {
        if (isRecord(row) && row.object === "page" && typeof row.id === "string") {
          childIds.push(normalizePageId(row.id));
        }
      }
    }
    onProgress?.(`Discovered ${childIds.length} child page(s) below ${normalizedId}.`);
    for (const childId of childIds) {
      await visit(childId);
    }
  }

  await visit(rootPageId);
}
