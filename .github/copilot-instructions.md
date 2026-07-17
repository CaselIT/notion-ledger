# Project Guidelines

## Product Contract

- Treat this file as the durable engineering contract and `README.md` as the current user-facing contract.
- This is a one-way, read-only Notion-to-GitHub Markdown mirror. Never write repository content back to Notion.
- Use only the official Notion API with an internal integration token. Never use browser cookies, undocumented APIs, or log the token.
- Scope discovery to the configured root page, its descendant `child_page` blocks, and rows returned by inline databases encountered in that tree. Do not search or export every page or database accessible to the integration.
- Optimize for readable, auditable Git diffs and stable history rather than lossless round-trip fidelity.

## Action Contract

- Run as a bundled Node.js 24 JavaScript Action. The Action exports files; it does not commit or push them.
- Inputs:
	- `notion-token` (required): internal integration token, supplied from an Actions secret.
	- `root-page` (required): Notion root page URL or ID.
	- `output-dir` (default `docs/notion`): repository-relative generated-file directory.
	- `add-frontmatter` (default `true`): include generated Notion metadata.
	- `delete-orphans` (default `true`): remove indexed pages no longer below the root.
	- `filename-strategy` (default `slug-and-id`): `stable-id`, `slug-and-id`, or `title`.
- Outputs: `pages-exported`, `pages-changed`, and `pages-deleted`.
- The default initial filename is `slug(title)--short-page-id.md`. Once indexed, preserve that path across title changes regardless of filename strategy.

## Behavioral Invariants

- Generated files must stay inside the configured `output-dir`, which must not be the repository root.
- Keep output deterministic. Do not add volatile values such as `synced_at`, and avoid rewriting unchanged files.
- Preserve the `.mirror-index.json` mapping so title changes retain existing paths and Git history.
- Export inline database rows as indexed Markdown files and link their titles from the parent database list using planned stable paths.
- Orphan cleanup may delete only validated files recorded in the mirror index. Never remove user-authored files or files outside `output-dir`.
- Continue using `notion-to-md` for block conversion. Do not replace it with hand-written block-to-Markdown conversion without a documented requirement.
- Keep `parseChildPages: false`: traversal and the mirror index own child-page discovery and paths, and each child page is rendered as its own file.
- Preserve source image/file URLs. Do not add asset downloading unless it is implemented end to end with stable names, URL rewriting, failure handling, size limits, tests, and documentation.

## Generated Page Format

- When front matter is enabled, serialize YAML safely with these fields: `source: notion`, `notion_page_id`, `notion_url`, `title`, `last_edited_at`, and optional `last_edited_by`.
- Follow front matter with `<!-- Generated from Notion. Edit the source page in Notion, not this file. -->`, then an H1 page title and the converted body.
- Never add a run timestamp or another field that changes when the source page has not changed.

## Markdown Fidelity

- Regression coverage should include paragraphs and headings; rich-text bold, italic, underline, strikethrough, links, and inline code; nested bullet, numbered, and task lists; quotes; dividers; fenced code with language labels; callouts; images and files; tables; and child pages.
- Checked and unchecked Notion `to_do` blocks must render as valid nested GFM tasks (`- [ ]` and `- [x]`).
- Document and test readable fallbacks for toggles, embeds, synced blocks, columns, databases, and unsupported blocks. Inline database rows are linked files; columns may flatten, and Markdown/HTML approximations are acceptable.
- Until durable asset downloading exists, preserve source image/file URLs and document that Notion-hosted URLs may expire.

## Code Ownership

- `src/inputs.ts`: input parsing and workspace path safety.
- `src/notion.ts`: root-scoped traversal, inline database row discovery, and page metadata extraction.
- `src/render.ts`: `notion-to-md` integration, YAML front matter, and generated page layout.
- `src/paths.ts`: filename strategies, collision handling, and indexed path safety.
- `src/state.ts`: deterministic writes, mirror index persistence, and orphan reconciliation.
- `src/index.ts`: Action orchestration, logs, outputs, and job summary.

Keep changes in the module that owns the behavior. Prefer small extensions of these boundaries over new abstractions.

## Tests And Release Artifact

- Use Node.js 24+ and the pinned dependencies in `package-lock.json`.
- Add focused regression tests for behavior changes, especially traversal, conversion output, path safety, rename stability, no-op runs, and orphan deletion.
- Run `npm run typecheck` and `npm test` after source or test changes.
- Run `npm run build` after any `src/**` change. GitHub Actions executes the checked-in `dist/index.cjs`; consumers do not install dependencies at runtime.
- Do not claim live Notion validation unless it was actually run with a representative Notion tree containing the block types listed above. Distinguish mocked converter/API tests from live integration results.

Before calling a release ready, verify that nested pages export, inline database rows link to their exported content, new children appear automatically, a one-sentence edit changes only its page, a no-op run produces no Git changes, nested tasks are valid GFM, unusual and duplicate titles are safe, rename paths remain stable, orphan policy works, and no secret appears in logs.

## Workflow And Security

- The Action exports files only; the consuming workflow stages, commits, and pushes them.
- Preserve `git add --all` before `git diff --cached --quiet` so new and deleted files are detected.
- Pin third-party GitHub Actions to immutable commit SHAs in production examples and keep workflow permissions limited to `contents: write` unless another permission is justified.
- Production should use a least-privilege read-only Notion integration shared only to a dedicated mirror root. The target repository should be private, with an appropriately protected default branch and a designated generated-file writer.