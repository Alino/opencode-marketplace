/**
 * Plugin source resolution — strategy pattern.
 * Modeled after VS Code's pluginSource.ts + pluginSources.ts in
 * src/vs/workbench/contrib/chat/common/plugins/pluginSource.ts
 * src/vs/workbench/contrib/chat/browser/pluginSources.ts
 *
 * Each source kind (relativePath, gitUrl, github) implements PluginSource
 * with ensure() / update() / getInstallPath() — matching VS Code's interface.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { sanitizeCacheSegment } from "./marketplaceReference.ts";

// ---------------------------------------------------------------------------
// Source descriptor union (mirrors VS Code's IPluginSourceDescriptor)
// ---------------------------------------------------------------------------

export type PluginSourceDescriptor =
  | {
      kind: "relativePath";
      /** Path relative to the marketplace repo root */
      relativePath: string;
      /** Absolute path to the root of the cloned marketplace repo */
      marketplaceRepoDir: string;
    }
  | {
      kind: "gitUrl";
      url: string;
      ref?: string;
      sha?: string;
      /** Optional subdirectory within the cloned repo */
      subPath?: string;
    }
  | {
      kind: "github";
      owner: string;
      repo: string;
      ref?: string;
      sha?: string;
      subPath?: string;
    };

// ---------------------------------------------------------------------------
// PluginSource interface (mirrors VS Code's IPluginSource)
// ---------------------------------------------------------------------------

export interface PluginSource {
  /** Absolute path to the installed plugin directory */
  getInstallPath(cacheRoot: string): string;
  /** Clone or verify the source is present on disk */
  ensure(cacheRoot: string): Promise<void>;
  /** Pull latest changes; resolves true if HEAD changed */
  update(cacheRoot: string): Promise<boolean>;
  /** Directory to delete on uninstall (undefined for relative-path sources) */
  getCleanupTarget(cacheRoot: string): string | undefined;
  getLabel(): string;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function gitExec(
  args: string[],
  cwd?: string
): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), ok: exitCode === 0 };
}

async function gitClone(
  url: string,
  dir: string,
  ref?: string
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const args = ["clone", "--depth=1"];
  if (ref) args.push("--branch", ref);
  args.push(url, dir);
  const result = await gitExec(args);
  if (!result.ok) {
    throw new Error(`git clone ${url} failed: ${result.stderr}`);
  }
}

async function gitCheckout(dir: string, ref: string): Promise<void> {
  let result = await gitExec(["checkout", ref], dir);
  if (!result.ok) {
    // ref might not be fetched yet — try fetching it first
    await gitExec(["fetch", "--depth=1", "origin", ref], dir);
    result = await gitExec(["checkout", ref], dir);
    if (!result.ok) {
      throw new Error(`git checkout ${ref} failed: ${result.stderr}`);
    }
  }
}

async function gitHeadSha(dir: string): Promise<string> {
  const result = await gitExec(["rev-parse", "HEAD"], dir);
  return result.stdout;
}

async function gitUpdate(
  dir: string,
  ref?: string
): Promise<{ changed: boolean }> {
  const before = await gitHeadSha(dir);
  if (ref) {
    await gitExec(["fetch", "--depth=1", "origin", ref], dir);
    await gitCheckout(dir, ref);
  } else {
    await gitExec(["fetch", "origin"], dir);
    await gitExec(["pull"], dir);
  }
  const after = await gitHeadSha(dir);
  return { changed: before !== after };
}

// ---------------------------------------------------------------------------
// Cache path computation (mirrors VS Code's AbstractGitPluginSource)
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic cache directory path for a git source.
 * Structure: cacheRoot/{host}/{path...}/{ref-or-sha-suffix}
 */
function gitCacheDir(
  cacheRoot: string,
  segments: string[],
  ref?: string,
  sha?: string
): string {
  const suffix = sha
    ? `sha_${sha.slice(0, 12)}`
    : ref
    ? `ref_${sanitizeCacheSegment(ref)}`
    : "ref_default";
  return path.join(cacheRoot, ...segments, suffix);
}

function cacheSegmentsForUrl(url: string): string[] {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.replace(/^\//, "").split("/").filter(Boolean);
    return [parsed.hostname, ...parts].map(sanitizeCacheSegment);
  } catch {
    // SCP-style: git@host:path
    const scpMatch = /^[^@]+@([^:]+):(.+?)(?:\.git)?$/.exec(url);
    if (scpMatch) {
      const host = scpMatch[1];
      const parts = scpMatch[2].split("/").filter(Boolean);
      return [host, ...parts].map(sanitizeCacheSegment);
    }
    return [sanitizeCacheSegment(url)];
  }
}

// ---------------------------------------------------------------------------
// Concrete implementations
// ---------------------------------------------------------------------------

/** A plugin whose source is a path within the already-cloned marketplace repo */
export class RelativePathSource implements PluginSource {
  constructor(
    private readonly desc: Extract<PluginSourceDescriptor, { kind: "relativePath" }>
  ) {}

  getInstallPath(_cacheRoot: string): string {
    return path.resolve(this.desc.marketplaceRepoDir, this.desc.relativePath);
  }

  async ensure(_cacheRoot: string): Promise<void> {
    // Already on disk — the marketplace fetch handled it
  }

  async update(_cacheRoot: string): Promise<boolean> {
    // Parent marketplace repo handles updates
    return false;
  }

  getCleanupTarget(_cacheRoot: string): string | undefined {
    // Part of the marketplace repo; don't delete independently
    return undefined;
  }

  getLabel(): string {
    return this.desc.relativePath;
  }
}

/** A plugin sourced from any git URL (HTTPS, SSH, SCP) */
export class GitUrlSource implements PluginSource {
  protected readonly segments: string[];

  constructor(
    protected readonly desc: Extract<PluginSourceDescriptor, { kind: "gitUrl" }>
  ) {
    this.segments = cacheSegmentsForUrl(desc.url);
  }

  private repoDir(cacheRoot: string): string {
    return gitCacheDir(cacheRoot, this.segments, this.desc.ref, this.desc.sha);
  }

  getInstallPath(cacheRoot: string): string {
    const repoDir = this.repoDir(cacheRoot);
    return this.desc.subPath ? path.join(repoDir, this.desc.subPath) : repoDir;
  }

  async ensure(cacheRoot: string): Promise<void> {
    const dir = this.repoDir(cacheRoot);
    const exists = await fs
      .access(dir)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      await gitClone(this.desc.url, dir, this.desc.ref);
    }
    // Checkout pinned ref/sha
    if (this.desc.sha) {
      await gitCheckout(dir, this.desc.sha);
    } else if (this.desc.ref) {
      await gitCheckout(dir, this.desc.ref);
    }
  }

  async update(cacheRoot: string): Promise<boolean> {
    const dir = this.repoDir(cacheRoot);
    const exists = await fs
      .access(dir)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      await this.ensure(cacheRoot);
      return true;
    }
    if (this.desc.sha) {
      // Pinned to exact SHA — check if we're already there
      const current = await gitHeadSha(dir);
      if (current === this.desc.sha) return false;
      await gitCheckout(dir, this.desc.sha);
      return true;
    }
    const { changed } = await gitUpdate(dir, this.desc.ref);
    return changed;
  }

  getCleanupTarget(cacheRoot: string): string | undefined {
    return this.repoDir(cacheRoot);
  }

  getLabel(): string {
    return this.desc.url;
  }
}

/** A plugin sourced from GitHub (owner/repo shorthand) */
export class GitHubSource extends GitUrlSource {
  constructor(
    desc: Extract<PluginSourceDescriptor, { kind: "github" }>
  ) {
    super({
      kind: "gitUrl",
      url: `https://github.com/${desc.owner}/${desc.repo}.git`,
      ref: desc.ref,
      sha: desc.sha,
      subPath: desc.subPath,
    });
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPluginSource(desc: PluginSourceDescriptor): PluginSource {
  switch (desc.kind) {
    case "relativePath":
      return new RelativePathSource(desc);
    case "gitUrl":
      return new GitUrlSource(desc);
    case "github":
      return new GitHubSource(desc);
  }
}
