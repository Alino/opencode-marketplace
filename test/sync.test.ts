import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { syncSkills } from "../src/sync.ts";
import { InstalledStore } from "../src/installedStore.ts";
import type { ResolvedSkill } from "../src/marketplaceService.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

async function mkTmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "ocp-sync-test-"));
}

/** Create a minimal fake skill directory with a SKILL.md */
async function makeSkillSource(dir: string, name: string): Promise<string> {
  const skillDir = path.join(dir, "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill ${name}\n---\n# ${name}\n`
  );
  // Add a supporting file to verify deep copy
  await fs.writeFile(path.join(skillDir, "extra.md"), "extra content");
  return skillDir;
}

function fakeSkill(
  name: string,
  sourceDir: string,
  sha = "abc123def456abc123def456abc123def456abc123"
): ResolvedSkill {
  return {
    name,
    sourceDir,
    marketplace: "https://github.com/test/marketplace.git",
    plugin: "test-plugin",
    ref: "v1.0.0",
    sha,
  };
}

beforeEach(async () => {
  tmpDir = await mkTmp();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("syncSkills", () => {
  it("installs an enabled skill", async () => {
    const sourceBase = path.join(tmpDir, "source");
    const skillSource = await makeSkillSource(sourceBase, "my-skill");

    const targetDir = path.join(tmpDir, "target");
    const storeFile = path.join(targetDir, ".marketplace-state.json");
    const store = new InstalledStore(storeFile);

    const available = new Map<string, ResolvedSkill>([
      ["my-skill", fakeSkill("my-skill", skillSource)],
    ]);

    const result = await syncSkills({
      available,
      enabled: ["my-skill"],
      targetDir,
      store,
    });

    expect(result.installed).toContain("my-skill");
    expect(result.errors).toHaveLength(0);

    // Verify SKILL.md was copied
    const copiedSkillMd = path.join(targetDir, "my-skill", "SKILL.md");
    const content = await fs.readFile(copiedSkillMd, "utf-8");
    expect(content).toContain("my-skill");

    // Verify supporting file was also copied
    const extraMd = path.join(targetDir, "my-skill", "extra.md");
    expect(await fs.access(extraMd).then(() => true).catch(() => false)).toBe(true);
  });

  it("skips unchanged skills (same SHA)", async () => {
    const sourceBase = path.join(tmpDir, "source");
    const skillSource = await makeSkillSource(sourceBase, "stable-skill");
    const sha = "aabbccddeeff0011223344556677889900aabbcc";

    const targetDir = path.join(tmpDir, "target");
    const storeFile = path.join(targetDir, ".marketplace-state.json");
    const store = new InstalledStore(storeFile);

    // First install
    const available = new Map([["stable-skill", fakeSkill("stable-skill", skillSource, sha)]]);
    await syncSkills({ available, enabled: ["stable-skill"], targetDir, store });

    // Second sync — same SHA
    const result = await syncSkills({
      available,
      enabled: ["stable-skill"],
      targetDir,
      store,
    });

    expect(result.unchanged).toContain("stable-skill");
    expect(result.installed).toHaveLength(0);
  });

  it("updates a skill when SHA changes", async () => {
    const sourceBase = path.join(tmpDir, "source");
    const skillSource = await makeSkillSource(sourceBase, "update-skill");

    const targetDir = path.join(tmpDir, "target");
    const store = new InstalledStore(path.join(targetDir, ".marketplace-state.json"));

    // First install at sha1
    const sha1 = "1111111111111111111111111111111111111111";
    await syncSkills({
      available: new Map([["update-skill", fakeSkill("update-skill", skillSource, sha1)]]),
      enabled: ["update-skill"],
      targetDir,
      store,
    });

    // Update to sha2
    const sha2 = "2222222222222222222222222222222222222222";
    const result = await syncSkills({
      available: new Map([["update-skill", fakeSkill("update-skill", skillSource, sha2)]]),
      enabled: ["update-skill"],
      targetDir,
      store,
    });

    expect(result.installed).toContain("update-skill");

    // Verify state has new SHA
    const state = await store.read();
    const entry = state.installed.find((e) => e.skill === "update-skill");
    expect(entry?.sha).toBe(sha2);
  });

  it("removes a skill that was disabled", async () => {
    const sourceBase = path.join(tmpDir, "source");
    const skillSource = await makeSkillSource(sourceBase, "removable-skill");

    const targetDir = path.join(tmpDir, "target");
    const store = new InstalledStore(path.join(targetDir, ".marketplace-state.json"));

    // Install
    await syncSkills({
      available: new Map([["removable-skill", fakeSkill("removable-skill", skillSource)]]),
      enabled: ["removable-skill"],
      targetDir,
      store,
    });

    // Disable (not in enabled anymore)
    const result = await syncSkills({
      available: new Map([["removable-skill", fakeSkill("removable-skill", skillSource)]]),
      enabled: [],
      targetDir,
      store,
    });

    expect(result.removed).toContain("removable-skill");

    // Directory should be gone
    const skillDir = path.join(targetDir, "removable-skill");
    expect(await fs.access(skillDir).then(() => true).catch(() => false)).toBe(false);
  });

  it("does not remove locally-created skills (unmanaged)", async () => {
    const targetDir = path.join(tmpDir, "target");
    await fs.mkdir(targetDir, { recursive: true });
    const store = new InstalledStore(path.join(targetDir, ".marketplace-state.json"));

    // Create a local skill (not managed by marketplace)
    const localSkillDir = path.join(targetDir, "local-skill");
    await fs.mkdir(localSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(localSkillDir, "SKILL.md"),
      "---\nname: local-skill\n---\n"
    );

    // Sync with no available skills
    const result = await syncSkills({
      available: new Map(),
      enabled: [],
      targetDir,
      store,
    });

    expect(result.removed).not.toContain("local-skill");

    // Local skill directory still exists
    expect(
      await fs.access(localSkillDir).then(() => true).catch(() => false)
    ).toBe(true);
  });

  it("reports error for enabled skill not found in any marketplace", async () => {
    const targetDir = path.join(tmpDir, "target");
    const store = new InstalledStore(path.join(targetDir, ".marketplace-state.json"));

    const result = await syncSkills({
      available: new Map(), // nothing available
      enabled: ["missing-skill"],
      targetDir,
      store,
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].skill).toBe("missing-skill");
  });

  it("persists installed state to disk", async () => {
    const sourceBase = path.join(tmpDir, "source");
    const skillSource = await makeSkillSource(sourceBase, "persisted-skill");
    const sha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

    const targetDir = path.join(tmpDir, "target");
    const storeFile = path.join(targetDir, ".marketplace-state.json");
    const store = new InstalledStore(storeFile);

    await syncSkills({
      available: new Map([["persisted-skill", fakeSkill("persisted-skill", skillSource, sha)]]),
      enabled: ["persisted-skill"],
      targetDir,
      store,
    });

    // Read state from disk with a fresh store instance
    const store2 = new InstalledStore(storeFile);
    const state = await store2.read();
    expect(state.version).toBe(1);
    expect(state.installed).toHaveLength(1);
    expect(state.installed[0].skill).toBe("persisted-skill");
    expect(state.installed[0].sha).toBe(sha);
  });
});

// ---------------------------------------------------------------------------
// InstalledStore unit tests
// ---------------------------------------------------------------------------

describe("InstalledStore", () => {
  it("returns empty state when file does not exist", async () => {
    const store = new InstalledStore(path.join(tmpDir, "nonexistent.json"));
    const state = await store.read();
    expect(state.version).toBe(1);
    expect(state.installed).toHaveLength(0);
  });

  it("upserts an entry", async () => {
    const store = new InstalledStore(path.join(tmpDir, "state.json"));
    let state = await store.read();
    state = store.upsertEntry(state, {
      skill: "x",
      marketplace: "m",
      plugin: "p",
      ref: "v1",
      sha: "aaa",
      syncedAt: "2026-01-01T00:00:00.000Z",
    });
    state = store.upsertEntry(state, {
      skill: "x",
      marketplace: "m",
      plugin: "p",
      ref: "v2",
      sha: "bbb",
      syncedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(state.installed).toHaveLength(1);
    expect(state.installed[0].sha).toBe("bbb");
  });

  it("removes an entry by skill name", async () => {
    const store = new InstalledStore(path.join(tmpDir, "state.json"));
    let state = await store.read();
    state = store.upsertEntry(state, {
      skill: "to-remove",
      marketplace: "m",
      plugin: "p",
      ref: "v1",
      sha: "ccc",
      syncedAt: "2026-01-01T00:00:00.000Z",
    });
    state = store.removeEntry(state, "to-remove");
    expect(store.getManagedSkills(state).has("to-remove")).toBe(false);
  });
});
