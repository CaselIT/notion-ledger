import path from "node:path";
import type { NotionToMarkdown } from "notion-to-md";
import { stringify } from "yaml";
import { normalizePageId } from "./inputs";
import { queryInlineDatabaseRows, type NotionClient, type PageMetadata } from "./notion";

export const GENERATED_MARKER =
  "<!-- Generated from Notion. Edit the source page in Notion, not this file. -->";

export function createFrontmatter(page: PageMetadata): string {
  const metadata: Record<string, string> = {
    source: "notion",
    notion_page_id: page.id,
    notion_url: page.url,
    title: page.title,
    last_edited_at: page.lastEditedAt,
  };
  if (page.lastEditedBy) {
    metadata.last_edited_by = page.lastEditedBy;
  }
  return `---\n${stringify(metadata, { lineWidth: 0 }).trimEnd()}\n---`;
}

export function renderPage(
  page: PageMetadata,
  markdown: string,
  addFrontmatter: boolean,
): string {
  const sections: string[] = [];
  if (addFrontmatter) {
    sections.push(createFrontmatter(page));
  }
  sections.push(GENERATED_MARKER, `# ${page.title}`);
  if (markdown.trim()) {
    sections.push(markdown.trim());
  }
  return `${sections.join("\n\n")}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRichText(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .filter((part): part is Record<string, unknown> => isRecord(part))
    .map((part) => typeof part.plain_text === "string" ? part.plain_text : "")
    .join("")
    .trim();
}

function isCompletedStatus(value: unknown): boolean {
  return typeof value === "string"
    && ["done", "complete", "completed"].includes(value.trim().toLowerCase());
}

function relativeMarkdownLink(currentPagePath: string, targetPagePath: string): string {
  const relativePath = path.posix.relative(path.posix.dirname(currentPagePath), targetPagePath);
  return relativePath
    .split("/")
    .map((segment) => segment === ".." ? segment : encodeURIComponent(segment))
    .join("/");
}

function renderInlineDatabaseRow(
  row: unknown,
  currentPagePath?: string,
  pagePaths?: Record<string, string>,
): string {
  if (!isRecord(row) || !isRecord(row.properties)) {
    return "- Untitled";
  }

  let title = "Untitled";
  let checked: boolean | undefined;
  const details: string[] = [];
  for (const [name, property] of Object.entries(row.properties)) {
    if (!isRecord(property)) {
      continue;
    }
    if (property.type === "title") {
      title = getRichText(property.title) || title;
    } else if (property.type === "checkbox" && typeof property.checkbox === "boolean") {
      checked = property.checkbox;
    } else if (property.type === "status") {
      checked = isRecord(property.status) && isCompletedStatus(property.status.name);
    } else if (property.type === "date" && isRecord(property.date)
      && typeof property.date.start === "string") {
      details.push(`${name}: ${property.date.start}`);
    }
  }

  const rowId = typeof row.id === "string" ? normalizePageId(row.id) : undefined;
  const targetPath = rowId ? pagePaths?.[rowId] : undefined;
  const label = currentPagePath && targetPath
    ? `[${title.replace(/([\\\[\]])/g, "\\$1")}](${relativeMarkdownLink(
      currentPagePath,
      targetPath,
    )})`
    : title;
  const suffix = details.length ? ` (${details.join(", ")})` : "";
  return checked === undefined
    ? `- ${label}${suffix}`
    : `- [${checked ? "x" : " "}] ${label}${suffix}`;
}

export function configureInlineDatabaseRenderer(
  n2m: NotionToMarkdown,
  notion: Pick<NotionClient, "databases" | "dataSources">,
  currentPagePath?: string,
  pagePaths?: Record<string, string>,
  onProgress?: (message: string) => void,
): void {
  n2m.setCustomTransformer("child_database", async (block) => {
    if (!("child_database" in block) || !isRecord(block.child_database)) {
      return false;
    }
    const title = typeof block.child_database.title === "string"
      && block.child_database.title.trim()
      ? block.child_database.title.trim()
      : "Database";
    const rows = await queryInlineDatabaseRows(notion, block.id, onProgress);
    const markdownRows = rows.map(
      (row) => renderInlineDatabaseRow(row, currentPagePath, pagePaths),
    );
    return [`## ${title}`, ...markdownRows].join("\n");
  });
}

export async function convertPage(
  n2m: NotionToMarkdown,
  pageId: string,
): Promise<string> {
  const blocks = await n2m.pageToMarkdown(pageId);
  if (blocks.length === 0) {
    return "";
  }
  const result = n2m.toMarkdownString(blocks);
  if (!result || typeof result.parent !== "string") {
    throw new Error(`Markdown conversion returned no parent content for page ${pageId}.`);
  }
  return result.parent;
}
