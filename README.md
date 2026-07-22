# Notion Ledger

Notion Ledger is a Node.js 24 exporter for GitHub Actions, Azure Pipelines, and local command-line use. It mirrors selected Notion page trees or databases to deterministic Markdown files. Notion remains the source of truth; the exporter never writes content back to Notion or commits repository changes itself.

## Setup

1. Create a Notion internal integration with the **Read content** capability. Enable **User information without email addresses** if generated front matter should include the last editor's name; otherwise `last_edited_by` records the stable Notion user ID.
2. Connect the integration to a dedicated top-level page containing the documentation to mirror. Creating an integration alone does not grant access to any pages.
3. Store the integration secret in the secret manager for the selected runtime. The examples below use `NOTION_TOKEN`.
4. Store the selected root page or database URLs or IDs in a newline-delimited variable such as `NOTION_MIRROR_ROOT_PAGES`.
5. Use a private target repository and protect its default branch as appropriate for the designated mirror bot.

Each configured root page, descendant `<page>` references returned by Notion's enhanced Markdown, and rows of inline databases referenced in that tree are exported. A configured root database acts as a container: every row page across all of its data sources is exported, followed by descendants referenced from those pages. The database itself does not produce a synthetic Markdown file. Other pages and databases accessible to the integration are not searched or exported.

## Usage

The exporter only writes files. The consuming workflow or user owns staging, committing, and pushing generated changes.

<details>
<summary>GitHub Actions</summary>

Pin both checkout and this Action to immutable commit SHAs in production.

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

For detailed progress, create an `ACTIONS_STEP_DEBUG` secret with the value `true` and rerun the workflow. Debug logs never include the integration token.

</details>

<details>
<summary>Azure Pipelines</summary>

The CLI bundle can run from Azure Pipelines without copying this repository's source into the consuming repository. Publish `dist/cli.cjs` and `dist/lib.cjs` as assets on a versioned GitHub Release, then download both assets from that immutable release in the pipeline. The two files must remain in the same directory.

```yaml
trigger: none
pr: none

schedules:
  # Azure evaluates cron schedules in UTC. Adjust as needed.
  - cron: "29,59 7-16 * * 1-5"
    displayName: Mirror Notion during the European workday
    branches:
      include:
        - main
    always: true

steps:
  - checkout: self

  - task: NodeTool@0
    inputs:
      versionSpec: "24.x"

  - task: DownloadGitHubRelease@0
    inputs:
      connection: github-service-connection
      userRepository: CaselIT/notion-ledger
      defaultVersionType: specificTag
      version: v1.0.0
      itemPattern: "*.cjs"
      downloadPath: $(Pipeline.Workspace)/notion-ledger-cli

  - script: node "$(Pipeline.Workspace)/notion-ledger-cli/cli.cjs"
    name: notionMirror
    displayName: Export Notion documentation
    env:
      NOTION_TOKEN: $(NOTION_TOKEN)
      ROOT_PAGES: $(NOTION_MIRROR_ROOT_PAGES)
      OUTPUT_DIR: docs/notion
      ADD_FRONTMATTER: "true"
      DELETE_ORPHANS: "true"
      FULL_EXPORT: "false"
      FILENAME_STRATEGY: slug-and-id
```

The schedule mirrors the GitHub example and still allows manual runs. `always: true` is required so Azure runs the mirror when Notion may have changed but the repository has not. Azure evaluates YAML cron expressions in UTC; adjust the expression and branch filter as needed. Schedules configured in the Azure Pipelines UI override YAML schedules and should be removed when using this example.

Use a secret pipeline variable for `NOTION_TOKEN` and a GitHub service connection authorized to read the release. If organization policy prevents GitHub release downloads, publish the same two files as an Azure Artifacts universal package instead; the CLI contract is unchanged. The consuming pipeline remains responsible for staging, committing, and pushing generated changes.

The CLI recognizes Azure Pipelines through `TF_BUILD`. It uses Azure debug, warning, and error log records and exposes `pages-exported`, `pages-changed`, and `pages-deleted` as output variables on the named script step. Set the standard `system.debug` pipeline variable to `true` for detailed traversal logs.

</details>

<details>
<summary>Local CLI</summary>

Install dependencies with `npm ci`, keep the token in an existing environment variable, and use an isolated output directory while testing. The local script invokes the same CLI entrypoint used by Azure Pipelines.

PowerShell:

```powershell
$env:NOTION_TOKEN = 'your-notion-token'
$env:ROOT_PAGES = $env:NOTION_MIRROR_ROOT_PAGES
$env:OUTPUT_DIR = 'docs/notion-local-test'
$env:ADD_FRONTMATTER = 'true'
$env:DELETE_ORPHANS = 'false'
$env:FULL_EXPORT = 'false'
$env:NOTION_LEDGER_DEBUG = 'true'

npm run mirror:local
```

Bash-like shell:

```sh
NOTION_TOKEN='your-notion-token' \
ROOT_PAGES="$NOTION_MIRROR_ROOT_PAGES" \
OUTPUT_DIR='docs/notion-local-test' \
ADD_FRONTMATTER='true' \
DELETE_ORPHANS='false' \
FULL_EXPORT='false' \
NOTION_LEDGER_DEBUG='true' \
npm run mirror:local
```

Replace the token placeholder at runtime, preferably from a local secret manager, and set newline-delimited `NOTION_MIRROR_ROOT_PAGES` before running the command. Do not commit either value. Enable orphan deletion only when testing in an isolated output directory.

</details>

## Inputs

| GitHub Action input | CLI environment variable | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `notion-token` | `NOTION_TOKEN` | Yes | | Notion internal integration token. Read it from a secret. |
| `root-pages` | `ROOT_PAGES` | Yes | | Newline-delimited Notion root page or database URLs or 32-character IDs. Duplicate IDs are ignored. |
| `output-dir` | `OUTPUT_DIR` | No | `docs/notion` | Repository-relative output directory. The repository root and paths outside the workspace are rejected. |
| `add-frontmatter` | `ADD_FRONTMATTER` | No | `true` | Include YAML source metadata in each Markdown file. |
| `delete-orphans` | `DELETE_ORPHANS` | No | `true` | Delete indexed mirror files for pages no longer found below the root. |
| `full-export` | `FULL_EXPORT` | No | `false` | Re-export every page instead of reusing files whose indexed Notion edit timestamp is unchanged. |
| `filename-strategy` | `FILENAME_STRATEGY` | No | `slug-and-id` | Initial path strategy: `stable-id`, `slug-and-id`, or `title`. |

Boolean inputs accept only `true` or `false` (case-insensitive).

The CLI resolves relative output paths from `BUILD_SOURCESDIRECTORY` when Azure Pipelines provides it, and from the current working directory otherwise. Set `NOTION_LEDGER_DEBUG=true` outside Azure Pipelines to enable detailed traversal logs.

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

Dependencies are pinned in `package-lock.json`. The checked-in `dist/action.cjs` bundle is the GitHub Action entry point, `dist/cli.cjs` is the CLI and Azure Pipelines entry point, and both load the shared exporter from `dist/lib.cjs`. All three artifacts must be rebuilt whenever source changes.

```bash
npm ci
npm run typecheck
npm run build
npm test
```
