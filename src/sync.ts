/**
 * Skill sync engine.
 * This is our addition on top of VS Code's pattern — VS Code loads plugins
 * directly from the cache directory, but OpenCode's skill discovery requires
 * SKILL.md files to exist in specific filesystem paths (.agents/skills/).
 *
 * The syncer bridges the gap: it copies enabled skills from the cache into
 * the project's .agents/skills/ directory and tracks what it manages via
 * InstalledStore so it never touches locally-created skills.
 */

import path from "node:path";
import fs from "node:fs/promises";
import type { ResolvedSkill } from "./marketplaceService.ts";
import { InstalledStore, type InstalledState } from "./installedStore.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyncResult {
  /** Skills newly copied or updated */
  installed: string[];
  /** Skills removed because they were disabled */
  removed: string[];
  /** Skills that were already up-to-date (same SHA) */
  unchanged: string[];
  errors: Array<{ skill: string; error: string }>;
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function removeDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/**
 * Sync enabled skills from the resolved set into the target directory.
 *
 * Rules (matching the user story's acceptance criteria):
 *  1. Only skills in `enabled` are copied to `targetDir`.
 *  2. Skills previously installed by us but no longer in `enabled` are removed.
 *  3. Skills in `targetDir` that we never installed are left untouched.
 *  4. Skills already at the correct SHA are skipped (unchanged).
 */
export async function syncSkills(opts: {
  available: Map<string, ResolvedSkill>;
  enabled: string[];
  targetDir: string;
  store: InstalledStore;
}): Promise<SyncResult> {
  const { available, enabled, targetDir, store } = opts;
  const result: SyncResult = {
    installed: [],
    removed: [],
    unchanged: [],
    errors: [],
  };

  // Ensure the skills directory exists
  await fs.mkdir(targetDir, { recursive: true });

  // Read current state
  let state = await store.read();
  const managed = store.getManagedSkills(state);

  // --- Step 1: Remove skills we manage that are no longer enabled ---
  for (const managedSkill of managed) {
    if (!enabled.includes(managedSkill)) {
      const skillDir = path.join(targetDir, managedSkill);
      try {
        await removeDir(skillDir);
        state = store.removeEntry(state, managedSkill);
        result.removed.push(managedSkill);
      } catch (e: any) {
        result.errors.push({
          skill: managedSkill,
          error: `Remove failed: ${e.message}`,
        });
      }
    }
  }

  // --- Step 2: Install / update enabled skills ---
  for (const skillName of enabled) {
    const resolved = available.get(skillName);
    if (!resolved) {
      result.errors.push({
        skill: skillName,
        error: "Skill not found in any configured marketplace",
      });
      continue;
    }

    const existingEntry = store.findEntry(state, skillName);

    // Skip if already installed at this exact SHA
    if (existingEntry?.sha === resolved.sha) {
      result.unchanged.push(skillName);
      continue;
    }

    const destDir = path.join(targetDir, skillName);
    try {
      // Remove stale copy (if any) then copy fresh
      await removeDir(destDir);
      await copyDir(resolved.sourceDir, destDir);

      state = store.upsertEntry(state, {
        skill: skillName,
        marketplace: resolved.marketplace,
        plugin: resolved.plugin,
        ref: resolved.ref,
        sha: resolved.sha,
        syncedAt: new Date().toISOString(),
      });

      result.installed.push(skillName);
    } catch (e: any) {
      result.errors.push({
        skill: skillName,
        error: `Install failed: ${e.message}`,
      });
    }
  }

  // Persist updated state
  await store.write(state);

  return result;
}
