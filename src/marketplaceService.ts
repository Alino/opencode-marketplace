/**
 * Marketplace catalog fetcher and parser.
 * Modeled after VS Code's pluginMarketplaceService.ts in
 * src/vs/workbench/contrib/chat/common/plugins/pluginMarketplaceService.ts
 *
 * Responsibilities:
 * - Clone/update the marketplace git repo to the local cache
 * - Discover and parse marketplace.json (checks 4 paths, mirrors VS Code)
 * - Fall back to a single plugin.json if no marketplace catalog found
 * - Resolve each plugin's source to a local directory
 * - Discover available skills within each resolved plugin directory
 */

import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import {
  type MarketplaceReference,
  sanitizeCacheSegment,
} from "./marketplaceReference.ts";
import {
  type PluginSourceDescriptor,
  createPluginSource,
} from "./pluginSource.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw shape of a plugin entry in marketplace.json */
interface MarketplacePluginEntry {
  name: string;
  description?: string;
  version?: string;
  /**
   * Source can be:
   *   - a string  → relative path within the marketplace repo
   *   - an object → external source (github, url, git-subdir, npm, pip)
   */
  source:
    | string
    | {
        source: "github" | "url" | "git-subdir" | "npm" | "pip";
        repo?: string;       // for github: "owner/repo"
        url?: string;        // for url / git-subdir
        path?: string;       // subdirectory within the cloned repo
        ref?: string;
        sha?: string;
        package?: string;    // for npm / pip
        version?: string;
        registry?: string;
      };
}

/** Raw shape of marketplace.json */
interface MarketplaceJson {
  name?: string;
  metadata?: { pluginRoot?: string };
  plugins: MarketplacePluginEntry[];
}

/** Raw shape of plugin.json (single-plugin manifest, fallback) */
interface PluginJson {
  name: string;
  description?: string;
  version?: string;
}

/** A plugin whose source directory has been resolved to an absolute path on disk */
export interface ResolvedPlugin {
  name: string;
  description?: string;
  /** Absolute path to the plugin's root directory */
  localDir: string;
  /** Skill names found under localDir/skills/<name>/SKILL.md */
  skills: string[];
}

/** A resolved skill ready to be synced into the project */
export interface ResolvedSkill {
  name: string;
  /** Absolute path to the skill directory (containing SKILL.md) */
  sourceDir: string;
  /** canonicalId of the marketplace that provided it */
  marketplace: string;
  /** Name of the plugin within the marketplace */
  plugin: string;
  /** Ref that was pinned (tag, branch, or "HEAD") */
  ref: string;
  /** Git HEAD SHA of the marketplace repo at sync time */
  sha: string;
}

// ---------------------------------------------------------------------------
// Marketplace.json discovery — same 4 paths VS Code checks, in order
// ---------------------------------------------------------------------------

const MARKETPLACE_JSON_PATHS = [
  "marketplace.json",
  ".plugin/marketplace.json",
  ".github/plugin/marketplace.json",
  ".claude-plugin/marketplace.json",
] as const;

const PLUGIN_JSON_PATHS = [
  ".plugin/plugin.json",
  ".claude-plugin/plugin.json",
  "plugin.json",
] as const;

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const text = await fs.readFile(filePath, "utf-8");
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function findMarketplaceJson(
  repoDir: string
): Promise<MarketplaceJson | null> {
  for (const rel of MARKETPLACE_JSON_PATHS) {
    const json = await readJson<MarketplaceJson>(path.join(repoDir, rel));
    if (json?.plugins) return json;
  }
  return null;
}

async function findPluginJson(repoDir: string): Promise<PluginJson | null> {
  for (const rel of PLUGIN_JSON_PATHS) {
    const json = await readJson<PluginJson>(path.join(repoDir, rel));
    if (json?.name) return json;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Skill discovery
// ---------------------------------------------------------------------------

/** Find skill names (directory names that contain a SKILL.md) under pluginDir/skills/ */
async function discoverSkills(pluginDir: string): Promise<string[]> {
  const skillsDir = path.join(pluginDir, "skills");
  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    const skills: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
      if (await fs.access(skillMd).then(() => true).catch(() => false)) {
        skills.push(entry.name);
      }
    }
    return skills;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Plugin source resolution
// ---------------------------------------------------------------------------

function buildSourceDescriptor(
  entry: MarketplacePluginEntry,
  marketplaceRepoDir: string
): PluginSourceDescriptor | null {
  const src = entry.source;

  if (typeof src === "string") {
    return {
      kind: "relativePath",
      relativePath: src,
      marketplaceRepoDir,
    };
  }

  switch (src.source) {
    case "github": {
      if (!src.repo) return null;
      const [owner, repo] = src.repo.split("/");
      if (!owner || !repo) return null;
      return { kind: "github", owner, repo, ref: src.ref, sha: src.sha, subPath: src.path };
    }

    case "url":
    case "git-subdir": {
      if (!src.url) return null;
      return { kind: "gitUrl", url: src.url, ref: src.ref, sha: src.sha, subPath: src.path };
    }

    case "npm":
    case "pip":
      // Not implemented — log and skip
      console.warn(
        `[opencode-marketplace] npm/pip plugin sources are not yet supported (plugin: ${entry.name})`
      );
      return null;

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Git helpers (subset used here for SHA retrieval)
// ---------------------------------------------------------------------------

async function gitHeadSha(dir: string): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "HEAD"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  return stdout.trim();
}

async function gitCloneOrUpdate(
  cloneUrl: string,
  repoDir: string,
  ref?: string
): Promise<{ sha: string; changed: boolean }> {
  const exists = await fs
    .access(repoDir)
    .then(() => true)
    .catch(() => false);

  if (!exists) {
    await fs.mkdir(repoDir, { recursive: true });
    const args = ["clone", "--depth=1"];
    if (ref) args.push("--branch", ref);
    args.push(cloneUrl, repoDir);
    const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
    const [stderr, exit] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exit !== 0) throw new Error(`git clone failed: ${stderr.trim()}`);
    const sha = await gitHeadSha(repoDir);
    return { sha, changed: true };
  }

  // Already cloned — try to update
  const before = await gitHeadSha(repoDir);
  try {
    if (ref) {
      const fetch = Bun.spawn(["git", "fetch", "--depth=1", "origin", ref], {
        cwd: repoDir, stdout: "pipe", stderr: "pipe",
      });
      await fetch.exited;
      const co = Bun.spawn(["git", "checkout", ref], {
        cwd: repoDir, stdout: "pipe", stderr: "pipe",
      });
      await co.exited;
    } else {
      const pull = Bun.spawn(["git", "pull"], {
        cwd: repoDir, stdout: "pipe", stderr: "pipe",
      });
      await pull.exited;
    }
  } catch (e: any) {
    console.warn(
      `[opencode-marketplace] Could not update "${repoDir}" (using cached): ${e.message}`
    );
  }
  const after = await gitHeadSha(repoDir);
  return { sha: after, changed: before !== after };
}

// ---------------------------------------------------------------------------
// Cache root
// ---------------------------------------------------------------------------

export function getMarketplaceCacheRoot(): string {
  return path.join(os.homedir(), ".cache", "opencode-marketplace");
}

function repoDir(ref: MarketplaceReference): string {
  const suffix = ref.ref
    ? `ref_${sanitizeCacheSegment(ref.ref)}`
    : "ref_default";
  return path.join(getMarketplaceCacheRoot(), ...ref.cacheSegments, suffix);
}

// ---------------------------------------------------------------------------
// Main fetch function
// ---------------------------------------------------------------------------

/**
 * Clone/update a marketplace repo and resolve all its plugins and their skills.
 * Returns both the resolved skills map (name → ResolvedSkill) and all plugins.
 *
 * For localFileUri references the directory is used directly (no clone needed).
 */
export async function fetchMarketplace(ref: MarketplaceReference): Promise<{
  skills: Map<string, ResolvedSkill>;
  plugins: ResolvedPlugin[];
  sha: string;
}> {
  const cacheRoot = getMarketplaceCacheRoot();

  // For local paths, use the directory directly without cloning
  let dir: string;
  let sha: string;

  if (ref.kind === "localFileUri") {
    const url = new URL(ref.cloneUrl);
    dir = url.pathname;
    sha = await gitHeadSha(dir).catch(() => "local");
  } else {
    dir = repoDir(ref);
    const result = await gitCloneOrUpdate(ref.cloneUrl, dir, ref.ref);
    sha = result.sha;
  }

  // Parse the catalog
  const catalog = await findMarketplaceJson(dir);
  const resolvedPlugins: ResolvedPlugin[] = [];

  if (catalog) {
    for (const entry of catalog.plugins) {
      const desc = buildSourceDescriptor(entry, dir);
      if (!desc) continue;

      const source = createPluginSource(desc);
      try {
        await source.ensure(cacheRoot);
        const localDir = source.getInstallPath(cacheRoot);
        const skills = await discoverSkills(localDir);
        resolvedPlugins.push({
          name: entry.name,
          description: entry.description,
          localDir,
          skills,
        });
      } catch (e: any) {
        console.warn(
          `[opencode-marketplace] Failed to resolve plugin "${entry.name}": ${e.message}`
        );
      }
    }
  } else {
    // Fallback: treat entire repo as a single plugin
    const pluginJson = await findPluginJson(dir);
    const skills = await discoverSkills(dir);
    if (pluginJson || skills.length > 0) {
      resolvedPlugins.push({
        name: pluginJson?.name ?? path.basename(dir),
        description: pluginJson?.description,
        localDir: dir,
        skills,
      });
    }
  }

  // Build skill map
  const skills = new Map<string, ResolvedSkill>();
  for (const plugin of resolvedPlugins) {
    for (const skillName of plugin.skills) {
      skills.set(skillName, {
        name: skillName,
        sourceDir: path.join(plugin.localDir, "skills", skillName),
        marketplace: ref.canonicalId,
        plugin: plugin.name,
        ref: ref.ref ?? "HEAD",
        sha,
      });
    }
  }

  return { skills, plugins: resolvedPlugins, sha };
}
