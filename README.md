# Notion Ledger

Notion Ledger is a Node.js 24 GitHub Action that mirrors one selected Notion page tree to deterministic Markdown files. Notion remains the source of truth; the Action never writes content back to Notion or commits repository changes itself.

## Setup

1. Create a Notion internal integration with the **Read content** capability. Enable **User information without email addresses** only if generated front matter should include the last editor's name; otherwise `last_edited_by` is omitted.
2. Connect the integration to a dedicated top-level page containing the documentation to mirror. Creating an integration alone does not grant access to any pages.
3. Store the integration secret as a repository Actions secret named `NOTION_TOKEN`.
4. Store the root page URL or ID as a repository variable such as `NOTION_MIRROR_ROOT_PAGE`.
5. Use a private target repository and protect its default branch as appropriate for the designated mirror bot.

The root page and descendant `child_page` blocks are exported. Other pages accessible to the integration are not searched or exported.

## Workflow

Pin both checkout and this Action to immutable commit SHAs in production. The consuming workflow owns staging, committing, and pushing the generated files.

```yaml
name: Mirror Notion documentation

on:
	workflow_dispatch:
	schedule:
		- cron: "*/30 * * * *"

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
					root-page: ${{ vars.NOTION_MIRROR_ROOT_PAGE }}
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
| `root-page` | Yes | | Root Notion page URL or 32-character page ID. |
| `output-dir` | No | `docs/notion` | Repository-relative output directory. The repository root and paths outside the workspace are rejected. |
| `add-frontmatter` | No | `true` | Include YAML source metadata in each Markdown file. |
| `delete-orphans` | No | `true` | Delete indexed mirror files for pages no longer found below the root. |
| `filename-strategy` | No | `slug-and-id` | Initial path strategy: `stable-id`, `slug-and-id`, or `title`. |

Boolean inputs accept only `true` or `false` (case-insensitive).

## Outputs

| Output | Description |
| --- | --- |
| `pages-exported` | Pages discovered and rendered during this run. |
| `pages-changed` | Markdown files created or whose content changed. |
| `pages-deleted` | Indexed orphan Markdown files deleted. |

## Generated Files

The default strategy initially creates paths such as:

```text
docs/notion/pricing-governance--8fe4a1b2.md
```

`docs/notion/.mirror-index.json` maps full Notion page IDs to paths. Once allocated, a page keeps its path when its title changes, preserving Git history and avoiding collisions between duplicate titles. The index is deterministic and belongs to one root page; using the same output directory for a different root fails instead of mixing mirrors.

Each generated page includes safely serialized YAML metadata, a generated-file warning, a title, and converted Markdown. Volatile synchronization timestamps are intentionally omitted, so rerunning without source changes produces no file changes.

With `delete-orphans: true`, only files recorded in the validated index are deleted. User-authored files in `output-dir` and every file outside it are left alone. With deletion disabled, prior orphan entries and files remain in the index so a page that returns keeps its original path.

## Markdown Behavior

Conversion is delegated to [`notion-to-md`](https://github.com/souvikinator/notion-to-md) using the official Notion API. It handles rich text, headings, lists, nested GFM task lists, quotes, dividers, code blocks, links, images, files, callouts, tables, toggles, synced blocks, and columns within Markdown's limits.

Known Milestone 1 limitations:

- Notion formatting is not losslessly reversible. Callouts and tables use Markdown/HTML approximations, toggles use HTML details blocks, and columns are flattened into reading order.
- Child pages are deliberately excluded from a parent's Markdown body and exported as their own indexed files.
- Inline database rows are rendered in place as a readable list. Checkbox properties and standard task statuses (`Done`, `Complete`, or `Completed`) become GFM task markers, and date properties are included as item details; views, filters, sorts, and other database properties are not reproduced.
- Images and file attachments retain their source URLs. Notion-hosted URLs may expire, so the current mirror is not a durable attachment archive.
- API pagination is handled for block traversal, but retries and explicit rate-limit backoff rely on the official SDK behavior in this release.

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

On windows in powershell:
```powershell
[Environment]::SetEnvironmentVariable('INPUT_NOTION-TOKEN', $env:NOTION_TOKEN, 'Process')
[Environment]::SetEnvironmentVariable('INPUT_ROOT-PAGE', $env:NOTION_MIRROR_ROOT_PAGE, 'Process')
[Environment]::SetEnvironmentVariable('INPUT_OUTPUT-DIR', 'docs/notion-local-test', 'Process')
[Environment]::SetEnvironmentVariable('INPUT_ADD-FRONTMATTER', 'true', 'Process')
[Environment]::SetEnvironmentVariable('INPUT_DELETE-ORPHANS', 'false', 'Process')
$env:GITHUB_WORKSPACE = (Get-Location).Path

npm run mirror:local
```

On a bash-like shell:
```sh
export INPUT_NOTION-TOKEN="$NOTION_TOKEN"
export INPUT_ROOT-PAGE="$NOTION_MIRROR_ROOT_PAGE"
export INPUT_OUTPUT-DIR='docs/notion-local-test'
export INPUT_ADD-FRONTMATTER='true'
export INPUT_DELETE-ORPHANS='false'
export GITHUB_WORKSPACE="$PWD"

npm run mirror:local
```

Set `NOTION_TOKEN` and `NOTION_MIRROR_ROOT_PAGE` in your shell or a local secret manager before running this command. Do not commit either value. After inspecting the generated output and mirror index, enable orphan deletion only when testing in an isolated output directory.
