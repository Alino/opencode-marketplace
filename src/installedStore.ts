/**
 * Installed skills state store.
 * Modeled after VS Code's fileBackedInstalledPluginsStore.ts in
 * src/vs/workbench/contrib/chat/common/plugins/fileBackedInstalledPluginsStore.ts
 *
 * Persists which skills were installed by the marketplace plugin so that:
 *  - On update, we can detect SHA changes and skip unchanged skills
 *  - On cleanup, we only remove skills we own (not locally created ones)
 */

import fs from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InstalledEntry {
  /** Skill directory name (= skill name) */
  skill: string;
  /** canonicalId of the marketplace that provided this skill */
  marketplace: string;
  /** Plugin name within that marketplace */
  plugin: string;
  /** Ref (tag/branch) that was pinned at install time */
  ref: string;
  /** Git HEAD SHA of the marketplace repo at install time */
  sha: string;
  /** ISO 8601 timestamp of when the skill was last synced */
  syncedAt: string;
}

export interface InstalledState {
  version: 1;
  installed: InstalledEntry[];
}

// ---------------------------------------------------------------------------
// InstalledStore
// ---------------------------------------------------------------------------

export class InstalledStore {
  constructor(private readonly stateFile: string) {}

  async read(): Promise<InstalledState> {
    try {
      const text = await fs.readFile(this.stateFile, "utf-8");
      const parsed = JSON.parse(text) as InstalledState;
      if (parsed.version === 1 && Array.isArray(parsed.installed)) {
        return parsed;
      }
    } catch {
      // File missing or corrupt — start fresh
    }
    return { version: 1, installed: [] };
  }

  async write(state: InstalledState): Promise<void> {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    await fs.writeFile(this.stateFile, JSON.stringify(state, null, 2), "utf-8");
  }

  /** Names of all skills currently tracked by the marketplace plugin */
  getManagedSkills(state: InstalledState): Set<string> {
    return new Set(state.installed.map((e) => e.skill));
  }

  /** Find the installed entry for a specific skill, if any */
  findEntry(
    state: InstalledState,
    skillName: string
  ): InstalledEntry | undefined {
    return state.installed.find((e) => e.skill === skillName);
  }

  /** Return a new state with the given entry upserted */
  upsertEntry(
    state: InstalledState,
    entry: InstalledEntry
  ): InstalledState {
    const installed = state.installed.filter((e) => e.skill !== entry.skill);
    return { version: 1, installed: [...installed, entry] };
  }

  /** Return a new state with the given skill removed */
  removeEntry(state: InstalledState, skillName: string): InstalledState {
    return {
      version: 1,
      installed: state.installed.filter((e) => e.skill !== skillName),
    };
  }
}
