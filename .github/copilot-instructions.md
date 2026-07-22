# Project Guidelines

## Product Contract

- Treat this file as the durable engineering contract and `README.md` as the current user-facing contract.
- This is a one-way, read-only Notion-to-repository Markdown mirror. Never write repository content back to Notion.
- Use only the official Notion API with an internal integration token. Never use browser cookies, undocumented APIs, or log the token.
- Scope discovery to configured root pages or databases, descendant `<page>` references returned by enhanced Markdown, rows returned by inline databases referenced in page trees, and rows returned by every data source of a configured root database. A root database is a traversal container and does not produce a synthetic Markdown file. Render page aliases as titled references marked outside the current root, but do not traverse their targets. Do not search or export every page or database accessible to the integration.
- Optimize for readable, auditable Git diffs and stable history rather than lossless round-trip fidelity.

## Runtime Contract

- Maintain one platform-neutral core with three checked-in CommonJS distribution artifacts: shared `dist/lib.cjs`, executable `dist/action.cjs` for GitHub Actions, and executable `dist/cli.cjs` for Azure Pipelines and local use. Treat `lib.cjs` as an internal runtime dependency of the executable artifacts rather than a documented public API. The exporter writes files; it does not commit or push them.
- Keep GitHub and CLI concerns in thin adapters around the shared core. Azure Pipelines is detected and supported by the CLI adapter rather than a separate exporter implementation.
- Inputs:
	- `notion-token` / `NOTION_TOKEN` (required): internal integration token, supplied from a secret.
	- `root-pages` / `ROOT_PAGES` (required): newline-delimited Notion root page or database URLs or IDs.
	- `output-dir` / `OUTPUT_DIR` (default `docs/notion`): repository-relative generated-file directory.
	- `add-frontmatter` / `ADD_FRONTMATTER` (default `true`): include generated Notion metadata.
	- `delete-orphans` / `DELETE_ORPHANS` (default `true`): remove indexed pages no longer below each configured root.
	- `full-export` / `FULL_EXPORT` (default `false`): re-export every page regardless of its indexed Notion edit timestamp.
	- `filename-strategy` / `FILENAME_STRATEGY` (default `slug-and-id`): `stable-id`, `slug-and-id`, or `title`.
- Outputs: `pages-exported`, `pages-changed`, and `pages-deleted`.
- The default initial filename is `slug(title)--short-page-id.md`. Once indexed, preserve that path across title changes regardless of filename strategy.

## Behavioral Invariants

- Generated files must stay inside the configured `output-dir`, which must not be the repository root.
- Allocate one stable title-and-ID directory and one mirror index per root. Preserve `.mirror-roots.json` so root title changes retain existing directories.
- Keep generated page content and the mirror index deterministic, and avoid rewriting unchanged files. Do not record run timestamps or other volatile fields in generated Markdown or the mirror index, so an unchanged run produces no Git diff.
- Preserve the `.mirror-index.json` mapping so title changes retain existing paths and Git history.
- When `full-export` is false, trust Notion's page `last_edited_time` and reuse an existing generated file only when its indexed timestamp matches, the file exists, and cached traversal references are available. Existing indexes without cached references must fall back to exporting the page once. A full export bypasses reuse without changing stable paths.
- Write each rendered page file before visiting the next page, but persist the mirror index only after traversal completes. Defer orphan deletion to that same point so an interrupted run retains the previous index and every file it references.
- Add a page to the in-memory index only after its file is successfully written, so a page that fails to export is never indexed. If a run fails or is interrupted (SIGINT/SIGTERM), persist the in-memory index of successfully exported pages without deleting orphans, so the next run can resume from partial progress.
- Export inline database rows as indexed Markdown files and link their titles from the parent database list using planned stable paths.
- Orphan cleanup may delete only validated files recorded in the mirror index. Never remove user-authored files or files outside `output-dir`.
- Removing a root from `root-pages` must not automatically delete its directory or root-index entry.
- Resolve each configured root as a page first, then fall back to the official database API only when Notion reports `object_not_found` or explicitly says the ID is a database rather than a page. Query every data source exposed by a root database and traverse returned row pages through the normal page export path.
- Use the official retrieve-page-Markdown API for content and child-reference discovery. Do not reconstruct page Markdown from block objects.
- Discover child references by parsing the enhanced Markdown for `<page>` and `<database>` tags rather than walking the block tree. This grep-based traversal is deliberate: the block/children API approach was too slow at scale, so accept the coupling to the Markdown tag format as the intended trade-off.
- Retrieve each page's Markdown at most once per run when its content or traversal references are not reusable, and reuse that response for rendering. Cache discovered page and database references in the mirror index so unchanged pages can still be traversed without another Markdown request. Query cached inline database references on every run. When Notion truncates a response, retrieve each reported unknown block subtree through the same official Markdown API and replace its placeholder in place. Resolve a self-referential page alias through the official block API, fetch its target title, and render it without traversing the target. Preserve other self-referential unresolved `<unknown>` placeholders with a visible warning. Traverse discovered page references depth-first; inline database rows continue to use the official database and data-source APIs.
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
- `src/notion.ts`: root-scoped enhanced-Markdown traversal, inline database row discovery, and page metadata extraction.
- `src/render.ts`: YAML front matter and generated page layout.
- `src/paths.ts`: filename strategies, collision handling, and indexed path safety.
- `src/state.ts`: deterministic writes, root/page index persistence, and orphan reconciliation.
- `src/lib.ts`: platform-neutral export orchestration, progress persistence, and results.
- `src/action.ts`: GitHub Action inputs, logs, outputs, and job summary.
- `src/cli.ts`: CLI inputs and local/Azure Pipelines logs and outputs.
- `src/action-entrypoint.ts` and `src/cli-entrypoint.ts`: minimal side-effectful executable entrypoints. Keep adapter modules import-safe for focused tests.

Keep changes in the module that owns the behavior. Prefer small extensions of these boundaries over new abstractions.

## Tests And Release Artifact

- Use Node.js 24+ and the pinned dependencies in `package-lock.json`.
- Prefer the scripts in `package.json` through `npm` over invoking `node_modules/.bin` or underlying tools directly. Use `npm run test:file -- test/example.test.ts` for a single test file. Use a direct invocation only when no suitable package script exists; native `node --test` cannot resolve this repository's extensionless TypeScript imports.
- Add focused regression tests for behavior changes, especially traversal, conversion output, path safety, rename stability, no-op runs, and orphan deletion.
- Adapter regression tests execute the built `dist/action.cjs` and `dist/cli.cjs` against a fake adjacent `lib.cjs`, without contacting Notion. Build before running them whenever source changes could affect an adapter or its shared-library import contract.
- After source changes, run `npm run typecheck`, `npm run build`, and then `npm test`, in that order. After test-only changes, run `npm run typecheck` and `npm test`.
- GitHub Actions executes the checked-in `dist/action.cjs`; CLI and Azure Pipelines consumers execute `dist/cli.cjs`. Both entrypoints require the adjacent checked-in `dist/lib.cjs`, and consumers do not install dependencies at runtime.
- Do not claim live Notion validation unless it was actually run with a representative Notion tree containing the block types listed above. Distinguish mocked converter/API tests from live integration results.

Before calling a release ready, verify that nested pages export, inline database rows link to their exported content, new children appear automatically, a one-sentence edit changes only its page, a no-op run produces no Git changes, nested tasks are valid GFM, unusual and duplicate titles are safe, rename paths remain stable, orphan policy works, and no secret appears in logs.

## Workflow And Security

- The Action exports files only; the consuming workflow stages, commits, and pushes them.
- Preserve `git add --all` before `git diff --cached --quiet` so new and deleted files are detected.
- Pin third-party GitHub Actions to immutable commit SHAs in production examples and keep workflow permissions limited to `contents: write` unless another permission is justified.
- Production should use a least-privilege read-only Notion integration shared only to dedicated mirror roots. The target repository should be private, with an appropriately protected default branch and a designated generated-file writer.