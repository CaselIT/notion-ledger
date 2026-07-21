import { stringify } from "yaml";
import type { PageMetadata } from "./notion";

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

