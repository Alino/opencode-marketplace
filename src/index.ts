/**
 * opencode-marketplace — OpenCode plugin entry point.
 *
 * Gives OpenCode the same marketplace capability that VS Code Copilot and
 * Claude Code have natively: fetch skills from a versioned git catalog,
 * sync only the enabled ones into .agents/skills/, and expose a
 * `marketplace` tool for the agent to inspect what's available.
 *
 * Consumer config lives at .agents/marketplace.json (single file,
 * committed to version control, reviewed in PRs):
 *
 *   {
 *     "marketplaces": [
 *       "your-org/shared-skills#v1.0.0"
 *     ],
 *     "enabled": ["llm-wiki"]
 *   }
 *
 * Skills are synced to .agents/skills/ (add to .gitignore).
 * State is tracked in .agents/skills/.marketplace-state.json (also gitignored).
 */

import path from "node:path";
import fs from "node:fs/promises";
import { tool } from "@opencode-ai/plugin";
import { parseMarketplaceReference } from "./marketplaceReference.ts";
import { fetchMarketplace } from "./marketplaceService.ts";
import { InstalledStore } from "./installedStore.ts";
import { syncSkills, type SyncResult } from "./sync.ts";
import type { ResolvedSkill } from "./marketplaceService.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface MarketplaceConfig {
  marketplaces: string[];
  enabled: string[];
}

async function readConfig(configPath: string): Promise<MarketplaceConfig | null> {
  try {
    const text = await fs.readFile(configPath, "utf-8");
    const json = JSON.parse(text) as MarketplaceConfig;
    if (!Array.isArray(json.marketplaces) || !Array.isArray(json.enabled)) {
      console.warn(
        "[opencode-marketplace] Invalid config: marketplaces and enabled must be arrays"
      );
      return null;
    }
    return json;
  } catch (e: any) {
    if (e.code === "ENOENT") return null; // no config = graceful no-op
    console.warn(`[opencode-marketplace] Could not read config: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Plugin type (subset of @opencode-ai/plugin's Plugin interface)
// ---------------------------------------------------------------------------

type Plugin = (ctx: {
  worktree: string;
  directory: string;
  [key: string]: unknown;
}) => Promise<{
  tool?: Record<string, unknown>;
}>;

// ---------------------------------------------------------------------------
// Marketplace summary (used by tool responses + kept for the session)
// ---------------------------------------------------------------------------

interface SessionState {
  available: Map<string, ResolvedSkill>;
  plugins: Array<{ marketplaceLabel: string; name: string; description?: string }>;
  config: MarketplaceConfig;
  lastSync: SyncResult;
}

// ---------------------------------------------------------------------------
// Main plugin function
// ---------------------------------------------------------------------------

const plugin: Plugin = async ({ worktree }) => {
  const configPath = path.join(worktree, ".agents", "marketplace.json");
  const config = await readConfig(configPath);

  // No config → be a no-op. Don't spam logs on repos without marketplace setup.
  if (!config) return {};

  const targetDir = path.join(worktree, ".agents", "skills");
  const stateFile = path.join(targetDir, ".marketplace-state.json");
  const store = new InstalledStore(stateFile);

  // --- Resolve all configured marketplaces ---
  const available = new Map<string, ResolvedSkill>();
  const sessionPlugins: SessionState["plugins"] = [];

  for (const rawRef of config.marketplaces) {
    const ref = parseMarketplaceReference(rawRef);
    if (!ref) {
      console.warn(
        `[opencode-marketplace] Cannot parse marketplace reference: "${rawRef}"`
      );
      continue;
    }

    try {
      const { skills, plugins } = await fetchMarketplace(ref);

      // Merge into available map (first marketplace wins on name conflicts)
      for (const [name, skill] of skills) {
        if (!available.has(name)) available.set(name, skill);
      }

      for (const p of plugins) {
        sessionPlugins.push({
          marketplaceLabel: ref.displayLabel,
          name: p.name,
          description: p.description,
        });
      }
    } catch (e: any) {
      console.error(
        `[opencode-marketplace] Failed to fetch marketplace "${ref.displayLabel}": ${e.message}`
      );
    }
  }

  // --- Sync enabled skills into .agents/skills/ ---
  const lastSync = await syncSkills({
    available,
    enabled: config.enabled,
    targetDir,
    store,
  });

  // Log meaningful changes; stay quiet on clean runs
  if (lastSync.installed.length > 0) {
    console.log(
      `[opencode-marketplace] Installed/updated: ${lastSync.installed.join(", ")}`
    );
  }
  if (lastSync.removed.length > 0) {
    console.log(
      `[opencode-marketplace] Removed: ${lastSync.removed.join(", ")}`
    );
  }
  for (const err of lastSync.errors) {
    console.warn(
      `[opencode-marketplace] Sync error (${err.skill}): ${err.error}`
    );
  }

  const session: SessionState = {
    available,
    plugins: sessionPlugins,
    config,
    lastSync,
  };

  // --- Register marketplace tool ---
  return {
    tool: {
      marketplace: tool({
        description:
          "Inspect and manage skills from configured marketplaces. " +
          "Use action=list to see what is available, action=status to see " +
          "what was synced this session, or action=search with a query to " +
          "find skills by name or description.",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["list", "status", "search"],
              description: "list | status | search",
            },
            query: {
              type: "string",
              description: "Search query (only used when action=search)",
            },
          },
          required: ["action"],
        },
        async execute({ action, query }) {
          switch (action) {
            case "list": {
              if (session.available.size === 0) {
                return "No skills found in any configured marketplace.";
              }
              const lines = ["Available skills (✓ = enabled, ○ = available):"];
              for (const [name, skill] of session.available) {
                const enabled = session.config.enabled.includes(name);
                lines.push(
                  `  ${enabled ? "✓" : "○"} ${name}` +
                    `  (${skill.marketplace} / ${skill.plugin}  @${skill.ref})`
                );
              }
              return lines.join("\n");
            }

            case "status": {
              const storeState = await store.read();
              const lines: string[] = [
                `Marketplaces : ${session.config.marketplaces.length}`,
                `Enabled      : ${session.config.enabled.join(", ") || "none"}`,
                `Available    : ${session.available.size} skills`,
                "",
                "Last sync:",
                `  Installed  : ${session.lastSync.installed.join(", ") || "none"}`,
                `  Unchanged  : ${session.lastSync.unchanged.join(", ") || "none"}`,
                `  Removed    : ${session.lastSync.removed.join(", ") || "none"}`,
              ];
              if (session.lastSync.errors.length > 0) {
                lines.push("  Errors:");
                for (const e of session.lastSync.errors) {
                  lines.push(`    ${e.skill}: ${e.error}`);
                }
              }
              if (storeState.installed.length > 0) {
                lines.push("", "Installed skills:");
                for (const entry of storeState.installed) {
                  lines.push(
                    `  ${entry.skill}  ${entry.ref} @ ${entry.sha.slice(0, 8)}` +
                      `  (synced ${entry.syncedAt.slice(0, 10)})`
                  );
                }
              }
              return lines.join("\n");
            }

            case "search": {
              const q = (query as string | undefined)?.toLowerCase();
              if (!q) return "Provide a query with action=search.";
              const matches: string[] = [];
              for (const [name, skill] of session.available) {
                const p = session.plugins.find((pl) => pl.name === skill.plugin);
                const desc = p?.description ?? "";
                if (name.toLowerCase().includes(q) || desc.toLowerCase().includes(q)) {
                  matches.push(`  ${name}: ${desc || "(no description)"}`);
                }
              }
              return matches.length > 0
                ? `Skills matching "${query}":\n${matches.join("\n")}`
                : `No skills matching "${query}".`;
            }

            default:
              return `Unknown action "${action}". Use list, status, or search.`;
          }
        },
      }),
    },
  };
};

export default plugin;
