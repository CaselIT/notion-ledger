# Notion Ledger

Notion Ledger is a Node.js 24 GitHub Action that mirrors selected Notion page trees or databases to deterministic Markdown files. Notion remains the source of truth; the Action never writes content back to Notion or commits repository changes itself.

## Setup

1. Create a Notion internal integration with the **Read content** capability. Enable **User information without email addresses** if generated front matter should include the last editor's name; otherwise `last_edited_by` records the stable Notion user ID.
2. Connect the integration to a dedicated top-level page containing the documentation to mirror. Creating an integration alone does not grant access to any pages.
3. Store the integration secret as a repository Actions secret named `NOTION_TOKEN`.
4. Store the selected root page or database URLs or IDs in a newline-delimited repository variable such as `NOTION_MIRROR_ROOT_PAGES`.
5. Use a private target repository and protect its default branch as appropriate for the designated mirror bot.

Each configured root page, descendant `<page>` references returned by Notion's enhanced Markdown, and rows of inline databases referenced in that tree are exported. A configured root database acts as a container: every row page across all of its data sources is exported, followed by descendants referenced from those pages. The database itself does not produce a synthetic Markdown file. Other pages and databases accessible to the integration are not searched or exported.

## Workflow

Pin both checkout and this Action to immutable commit SHAs in production. The consuming workflow owns staging, committing, and pushing the generated files.

```yaml
name: Mirror Notion documentation

on:
  workflow_dispatch:
  schedule:
    # At :29 and :59 during the European workday business hours. Adjust as needed
    - cron: "29,59 7-16 * * 1-5"

permissions:
  contents: write

jobs:
  mirror:
    runs-on: ubuntu-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@12cd2235efa0937479335606d7c3ac9f6c0973b1
        with:
          fetch-depth: 0

      - name: Export Notion documentation
        uses: CaselIT/notion-ledger@<PINNED_COMMIT_SHA>
        with:
          notion-token: ${{ secrets.NOTION_TOKEN }}
          root-pages: ${{ vars.NOTION_MIRROR_ROOT_PAGES }}
          output-dir: docs/notion
          add-frontmatter: "true"
          delete-orphans: "true"

      - name: Commit documentation updates
        shell: bash
        run: |
          git add --all
          if git diff --cached --quiet; then
            echo "No Notion content changes found."
            exit 0
          fi

          git config user.name "notion-sync-bot"
          git config user.email "notion-sync-bot@users.noreply.github.com"
          git commit -m "docs: mirror Notion knowledge base"
          git push
```

Staging with `git add --all` before `git diff --cached --quiet` is required so newly created and deleted files are detected.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `notion-token` | Yes | | Notion internal integration token. Read it from an Actions secret. |
| `root-pages` | Yes | | Newline-delimited Notion root page or database URLs or 32-character IDs. Duplicate IDs are ignored. |
| `output-dir` | No | `docs/notion` | Repository-relative output directory. The repository root and paths outside the workspace are rejected. |
| `add-frontmatter` | No | `true` | Include YAML source metadata in each Markdown file. |
| `delete-orphans` | No | `true` | Delete indexed mirror files for pages no longer found below the root. |
| `full-export` | No | `false` | Re-export every page instead of reusing files whose indexed Notion edit timestamp is unchanged. |
| `filename-strategy` | No | `slug-and-id` | Initial path strategy: `stable-id`, `slug-and-id`, or `title`. |

Boolean inputs accept only `true` or `false` (case-insensitive).

## Outputs

| Output | Description |
| --- | --- |
| `pages-exported` | Pages discovered and mirrored during this run, including reused files. |
| `pages-changed` | Markdown files created or whose content changed. |
| `pages-deleted` | Indexed orphan Markdown files deleted. |

## Generated Files

Each root receives a stable directory, and the default strategy initially creates paths such as:

```text
docs/notion/
  .mirror-roots.json
  engineering--8fe4a1b2/
    .mirror-index.json
    engineering--8fe4a1b2.md
    pricing-governance--12345678.md
```

`.mirror-roots.json` maps configured root IDs to directories. Each root directory has its own `.mirror-index.json`, which maps full Notion page IDs to paths and records `last_edited_at` and discovered page/database references from Notion. Once allocated, root directories and page paths remain stable across title changes, preserving Git history and avoiding collisions between duplicate titles.

Each generated page includes safely serialized YAML metadata, a generated-file warning, a title, and converted Markdown. Volatile synchronization timestamps are omitted from both generated pages and the mirror index, so an unchanged run produces no Git diff.

By default, the Action retrieves metadata for every discovered page and trusts Notion's `last_edited_time`. When it exactly matches the indexed value, the generated file still exists, and cached references are available, the Action skips that page's Markdown retrieval and rendering. Cached page references preserve depth-first traversal, while cached inline database references are queried live on every run so row additions and removals are still discovered. Legacy indexes without cached references populate them during one ordinary export. Set `full-export: "true"` to bypass timestamp reuse for a run.

Pages that require rendering are persisted as they are discovered rather than buffered until the complete tree has loaded. The in-memory mirror index is updated after each successful page write. It is persisted after traversal completes or when the existing failure/signal handler saves partial progress. Indexed pages not encountered in the current run remain untouched until discovery finishes successfully; only then can orphan cleanup remove them.

With `delete-orphans: true`, only files recorded in each configured root's validated index are deleted. User-authored files in `output-dir` and every file outside it are left alone. Removing a root from `root-pages` does not delete its directory or root-index entry. With deletion disabled, prior orphan entries and files remain in the page index so a page that returns keeps its original path.

## Markdown Behavior

Content is retrieved through Notion's official [Markdown API](https://developers.notion.com/reference/retrieve-page-markdown). It returns Notion's enhanced Markdown format, which supports rich text, headings, lists, nested task lists, quotes, dividers, code blocks, links, media, callouts, tables, toggles, synced blocks, and columns in one request for most pages.

Known Milestone 1 limitations:

- Enhanced Markdown uses Notion-specific XML-like tags for structures that standard Markdown cannot represent, including callouts, tables, toggles, columns, child pages, and inline databases.
- Child pages and inline databases appear in parent content as `<page>` and `<database>` references while their descendant pages and database rows are exported as their own indexed files. A Notion page alias is rendered as a titled `<page>` reference marked `outside-current-root="true"`; its target is not traversed or exported from that root, avoiding duplicate exports and cross-root cycles.
- Images and file attachments retain their source URLs. Notion-hosted URLs may expire, so the current mirror is not a durable attachment archive.
- Pages above Notion's Markdown response limit are completed through follow-up Markdown requests for each `unknown_block_id`. Recovered subtrees replace their `<unknown>` placeholders in place. Self-referential page aliases are resolved through the official block API into labeled, non-traversed page references. If another block remains unresolved, the Action emits a warning and preserves the explicit `<unknown>` placeholder rather than omitting content or failing the entire mirror.
- API pagination is handled for inline database queries, and the official SDK retries retryable rate-limit and service errors in this release.

Before broad adoption, run the Action against a representative Notion tree containing rich text, nested lists and tasks, code, callouts, media, tables, toggles, synced blocks, columns, and unsupported content. Review the generated Markdown and document any workspace-specific fidelity requirements.

## Development

Dependencies are pinned in `package-lock.json`. The checked-in `dist/index.cjs` bundle is the Action entry point and must be rebuilt whenever source changes.

```bash
npm ci
npm run typecheck
npm test
npm run build
```

### Local Mirror

`npm run mirror:local` performs a live export against Notion. It uses the same Action input environment variables as GitHub Actions, so keep the token in an existing local environment variable and use a separate output directory while testing.

For detailed progress, the Action uses the standard `@actions/core` debug channel. In GitHub Actions, create an `ACTIONS_STEP_DEBUG` secret with the value `true` and rerun the workflow to show page retrieval and inline database query logs. For local runs, set `RUNNER_DEBUG=1` to enable the equivalent runner debug mode. Debug logs never include the integration token.

On windows in powershell:
```powershell
[Environment]::SetEnvironmentVariable('INPUT_NOTION-TOKEN', $env:NOTION_TOKEN, 'Process')
[Environment]::SetEnvironmentVariable('INPUT_ROOT-PAGES', $env:NOTION_MIRROR_ROOT_PAGES, 'Process')
[Environment]::SetEnvironmentVariable('INPUT_OUTPUT-DIR', 'docs/notion-local-test', 'Process')
[Environment]::SetEnvironmentVariable('INPUT_ADD-FRONTMATTER', 'true', 'Process')
[Environment]::SetEnvironmentVariable('INPUT_DELETE-ORPHANS', 'false', 'Process')
[Environment]::SetEnvironmentVariable('INPUT_FULL-EXPORT', 'false', 'Process')
$env:RUNNER_DEBUG = '1'
$env:GITHUB_WORKSPACE = (Get-Location).Path

npm run mirror:local
```

On a bash-like shell:
```sh
export GITHUB_WORKSPACE="$PWD"

env \
  'RUNNER_DEBUG'='1' \
  'INPUT_NOTION-TOKEN'="$NOTION_TOKEN" \
  'INPUT_ROOT-PAGES'="$NOTION_MIRROR_ROOT_PAGES" \
  'INPUT_OUTPUT-DIR'='docs/notion-local-test' \
  'INPUT_ADD-FRONTMATTER'='true' \
  'INPUT_DELETE-ORPHANS'='false' \
  'INPUT_FULL-EXPORT'='false' \
  npm run mirror:local
```

Set `NOTION_TOKEN` and newline-delimited `NOTION_MIRROR_ROOT_PAGES` in your shell or a local secret manager before running this command. Do not commit either value. After inspecting the generated output and mirror indexes, enable orphan deletion only when testing in an isolated output directory.
