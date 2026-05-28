# opencode-marketplace

An [OpenCode](https://opencode.ai) plugin that gives your repos the same marketplace-based skill distribution that VS Code Copilot and Claude Code have natively.

Skills live in a central git repository. Each consumer repo declares which skills it wants in a single config file. On every OpenCode session startup the plugin fetches the right versions and syncs them into `.agents/skills/` — where OpenCode, VS Code Copilot, and Claude Code all discover them automatically.

```
Central skills repo (GitHub / Azure DevOps / any git host)
  marketplace.json          ← catalog of available skills
  .claude-plugin/
    plugin.json             ← cross-tool plugin manifest
  skills/
    my-skill/
      SKILL.md

Consumer repo
  .agents/
    marketplace.json        ← which marketplaces + which skills (committed, reviewed in PRs)
    skills/                 ← synced at startup (gitignored)
      my-skill/
        SKILL.md
  .opencode/
    plugins/
      marketplace.js        ← this plugin (committed)
```

## Why

OpenCode has no built-in marketplace. VS Code Copilot and Claude Code do. This plugin bridges the gap so all three tools can consume skills from the same central repo using the same catalog format.

The plugin is modeled after VS Code's own marketplace implementation (`pluginMarketplaceService.ts`, `pluginSource.ts`, `marketplaceReference.ts`) for parity in URL format support, cache layout, and update strategy.

## Installing into OpenCode

### Option A: Install from GitHub (recommended)

Run this inside your repo:

```bash
opencode plugin Alino/opencode-marketplace
```

OpenCode uses npm's package resolver under the hood, which understands GitHub shorthand natively. This adds `"plugin": ["Alino/opencode-marketplace"]` to your `opencode.json` and installs the package automatically on the next startup. No build step, no file copying.

You can also pin to a specific tag or commit:

```bash
opencode plugin Alino/opencode-marketplace#v1.0.0
```

### Option B: Local bundle

Build the bundle and commit it as a local plugin file. OpenCode auto-discovers any `.js` or `.ts` file placed in `.opencode/plugins/` — no `opencode.json` change required.

```bash
# 1. Clone and build
git clone https://github.com/Alino/opencode-marketplace
cd opencode-marketplace
bun install
bun run bundle                    # produces dist/opencode-marketplace.js

# 2. Copy into your repo's plugin directory
mkdir -p <your-repo>/.opencode/plugins
cp dist/opencode-marketplace.js <your-repo>/.opencode/plugins/marketplace.js
```

The committed `marketplace.js` travels with the repo so every team member gets it without any installation step. Useful when you need the plugin to work offline or want to vendor a specific build.

## Setup

### 1. Create a skills repo

Structure it as a standard cross-tool plugin:

```
my-skills/
├── .claude-plugin/
│   └── plugin.json         # { "name": "my-skills", "version": "1.0.0" }
├── marketplace.json         # catalog (see format below)
└── skills/
    └── my-skill/
        └── SKILL.md
```

`marketplace.json` format (compatible with VS Code Copilot and Claude Code):

```json
{
  "name": "my-marketplace",
  "plugins": [
    {
      "name": "my-skills",
      "description": "My shared AI skills",
      "source": ".",
      "version": "1.0.0"
    }
  ]
}
```

### 2. Install the plugin

```bash
opencode plugin Alino/opencode-marketplace
```

See [Installing into OpenCode](#installing-into-opencode) for other options.

### 3. Create `.agents/marketplace.json`

This is the single config file — commit it so skill changes are reviewed in PRs:

```json
{
  "marketplaces": [
    "your-org/your-skills-repo#v1.0.0"
  ],
  "enabled": ["my-skill"]
}
```

**Supported reference formats** (same as VS Code Copilot):

| Format | Example |
|---|---|
| GitHub shorthand | `owner/repo` |
| GitHub with ref | `owner/repo#v1.0.0` |
| HTTPS git URL | `https://github.com/owner/repo.git#v1.0.0` |
| Azure DevOps HTTPS | `https://dev.azure.com/org/project/_git/repo` |
| SCP-style SSH | `git@github.com:owner/repo.git#v1.0.0` |
| Azure DevOps SSH | `git@ssh.dev.azure.com:v3/org/project/repo#v1.0.0` |
| Local file | `file:///path/to/local/repo` |

### 4. Gitignore the synced skills

```gitignore
# Synced by opencode-marketplace at startup
.agents/skills/
```

### 5. Start OpenCode

On startup the plugin:
1. Fetches/updates the marketplace repo (cached at `~/.cache/opencode-marketplace/`)
2. Parses `marketplace.json` — checks all 4 catalog paths VS Code checks
3. Copies enabled skills to `.agents/skills/`
4. Registers a `marketplace` tool the agent can use

OpenCode auto-discovers skills in `.agents/skills/` without any extra config. If you are on an older version that doesn't, add this to your `opencode.json`:

```json
{
  "skills": { "paths": [".agents/skills"] }
}
```

## The `marketplace` tool

During a session the agent can call the `marketplace` tool directly:

| Action | What it does |
|---|---|
| `action=list` | Show all available skills (`✓` enabled, `○` available but not enabled) |
| `action=status` | Show last sync results and installed versions with SHAs |
| `action=search query=<q>` | Search available skills by name or description |

## Upgrading skills

Bump the ref in `.agents/marketplace.json`:

```json
{
  "marketplaces": ["your-org/your-skills-repo#v1.1.0"],
  "enabled": ["my-skill"]
}
```

Commit → PR → review → merge. The next session syncs the new version.

## Enabling / disabling skills

Add or remove skill names from `enabled`. The change shows up in the PR diff — reviewable like any other code change.

## How it works

The plugin is split into five modules, each modeled after a VS Code counterpart:

| Module | VS Code equivalent | Purpose |
|---|---|---|
| `marketplaceReference.ts` | `marketplaceReference.ts` | Parse all supported URL formats, normalize canonical IDs for dedup |
| `pluginSource.ts` | `pluginSource.ts` + `pluginSources.ts` | Strategy pattern — git clone/update for each source kind |
| `marketplaceService.ts` | `pluginMarketplaceService.ts` | Fetch marketplace repo, parse catalog (4 path locations), discover skills |
| `installedStore.ts` | `fileBackedInstalledPluginsStore.ts` | Persist installed skill state to `.marketplace-state.json` |
| `sync.ts` | *(addition)* | Copy skills from cache to `.agents/skills/`, skip unchanged SHAs, only remove managed skills |

**Cache layout** (`~/.cache/opencode-marketplace/`):

```
github.com/owner/repo/ref_v1.0.0/
ssh.dev.azure.com/v3/org/proj/repo/ref_main/
local/path/to/local/repo/ref_default/
```

Each `ref_*` or `sha_*` subdirectory is an independent clone so different consumer repos pinned to different versions never conflict.

## Development

```bash
bun install
bun test           # 35 tests
bun run typecheck
bun run bundle     # build dist/opencode-marketplace.js
```

## License

MIT — Alexander Sadovsky
