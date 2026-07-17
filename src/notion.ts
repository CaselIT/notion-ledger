import { APIErrorCode, APIResponseError } from "@notionhq/client";
import { normalizePageId } from "./inputs";

interface BlockResponse {
  id: string;
  type?: string;
  has_children?: boolean;
}

interface PageResponse {
  id: string;
  url: string;
  last_edited_time: string;
  last_edited_by?: unknown;
  properties: Record<string, unknown>;
}

export interface NotionClient {
  blocks: {
    children: {
      list: (parameters: {
        block_id: string;
        page_size: number;
        start_cursor?: string;
      }) => Promise<{
        results: BlockResponse[];
        has_more: boolean;
        next_cursor: string | null;
      }>;
    };
  };
  pages: {
    retrieve: (parameters: { page_id: string }) => Promise<unknown>;
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

export interface DiscoverPagesOptions {
  onUserInfoUnavailable?: () => void;
}

export async function listAllChildren(
  notion: NotionClient,
  blockId: string,
): Promise<BlockResponse[]> {
  const blocks: BlockResponse[] = [];
  let cursor: string | undefined;
  do {
    const response = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    blocks.push(...response.results);
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);

  return blocks;
}

export async function findChildPageIds(
  notion: NotionClient,
  blockId: string,
): Promise<string[]> {
  const pageIds: string[] = [];
  const blocks = await listAllChildren(notion, blockId);

  for (const block of blocks) {
    if ("type" in block && block.type === "child_page") {
      pageIds.push(normalizePageId(block.id));
    } else if ("has_children" in block && block.has_children) {
      pageIds.push(...await findChildPageIds(notion, block.id));
    }
  }

  return pageIds;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  { onUserInfoUnavailable }: DiscoverPagesOptions = {},
): Promise<PageMetadata[]> {
  const pages: PageMetadata[] = [];
  const visited = new Set();
  const userNames = new Map<string, Promise<string | undefined>>();
  let userInfoAvailable = true;

  async function visit(pageId: string): Promise<void> {
    const normalizedId = normalizePageId(pageId);
    if (visited.has(normalizedId)) {
      return;
    }
    visited.add(normalizedId);

    const page = await notion.pages.retrieve({ page_id: normalizedId });
    const metadata = toPageMetadata(page);
    const lastEditedById = getLastEditedById(page);
    if (!metadata.lastEditedBy && lastEditedById && userInfoAvailable) {
      const name = userNames.get(lastEditedById) ?? retrieveUserName(
        notion,
        lastEditedById,
      ).catch((error: unknown) => {
        if (
          APIResponseError.isAPIResponseError(error)
          && error.code === APIErrorCode.RestrictedResource
        ) {
          userInfoAvailable = false;
          onUserInfoUnavailable?.();
          return undefined;
        }
        throw error;
      });
      userNames.set(lastEditedById, name);
      metadata.lastEditedBy = await name;
    }
    pages.push(metadata);

    const childIds = await findChildPageIds(notion, normalizedId);
    for (const childId of childIds) {
      await visit(childId);
    }
  }

  await visit(rootPageId);
  return pages;
}
