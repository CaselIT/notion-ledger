import path from "node:path";

const PAGE_ID_PATTERN = /(?:^|[^0-9a-f])([0-9a-f]{32})(?:[^0-9a-f]|$)/i;

export function parseBoolean(value: string, name: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  throw new Error(`${name} must be "true" or "false".`);
}

export function normalizePageId(value: string): string {
  const compact = value.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) {
    throw new Error("root-pages must contain valid 32-character Notion page or database IDs.");
  }
  return compact;
}

function parseRootPageId(value: string): string {
  const trimmed = value.trim();

  const directId = trimmed.replaceAll("-", "");
  if (/^[0-9a-f]{32}$/i.test(directId)) {
    return normalizePageId(directId);
  }

  let decoded;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    decoded = trimmed;
  }
  const match = decoded.match(PAGE_ID_PATTERN);
  if (!match) {
    throw new Error("Each root-pages entry must be a Notion page or database URL or ID.");
  }
  return normalizePageId(match[1]);
}

export function parseRootPageIds(value: string): string[] {
  const entries = value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error("root-pages must contain at least one Notion page or database URL or ID.");
  }
  return [...new Set(entries.map(parseRootPageId))];
}

export function resolveOutputDirectory(workspace: string, outputDir: string): string {
  const value = outputDir.trim();
  if (!value) {
    throw new Error("output-dir cannot be empty.");
  }
  if (path.isAbsolute(value)) {
    throw new Error("output-dir must be relative to the GitHub workspace.");
  }

  const workspacePath = path.resolve(workspace);
  const resolved = path.resolve(workspacePath, value);
  const relative = path.relative(workspacePath, resolved);
  if (!relative) {
    throw new Error("output-dir must not be the GitHub workspace root.");
  }
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("output-dir must stay inside the GitHub workspace.");
  }
  return resolved;
}

export type FilenameStrategy = "stable-id" | "slug-and-id" | "title";

export function parseFilenameStrategy(value: string): FilenameStrategy {
  const allowed = new Set(["stable-id", "slug-and-id", "title"]);
  if (!allowed.has(value)) {
    throw new Error("filename-strategy must be stable-id, slug-and-id, or title.");
  }
  return value as FilenameStrategy;
}
