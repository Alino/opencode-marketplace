import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fetchMarketplace } from "../src/marketplaceService.ts";
import { parseMarketplaceReference } from "../src/marketplaceReference.ts";

// ---------------------------------------------------------------------------
// Helpers — build a fake local marketplace repo on disk
// ---------------------------------------------------------------------------

let tmpDir: string;
let fakeRepoDir: string;

async function initGitRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const run = (args: string[]) =>
    Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" }).exited;
  await run(["init"]);
  await run(["config", "user.email", "test@test.com"]);
  await run(["config", "user.name", "Test"]);
}

async function gitCommitAll(dir: string, message: string): Promise<void> {
  const run = (args: string[]) =>
    Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" }).exited;
  await run(["add", "-A"]);
  await run(["commit", "-m", message]);
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ocp-test-"));
  fakeRepoDir = path.join(tmpDir, "fake-marketplace");

  // Build a fake SharedSkills-style repo with one skill
  await initGitRepo(fakeRepoDir);

  // marketplace.json at root
  await fs.writeFile(
    path.join(fakeRepoDir, "marketplace.json"),
    JSON.stringify({
      name: "test-marketplace",
      plugins: [
        { name: "test-plugin", description: "A test plugin", source: "." },
      ],
    })
  );

  // .claude-plugin/plugin.json
  await fs.mkdir(path.join(fakeRepoDir, ".claude-plugin"), { recursive: true });
  await fs.writeFile(
    path.join(fakeRepoDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "test-plugin", version: "1.0.0" })
  );

  // skills/my-skill/SKILL.md
  await fs.mkdir(path.join(fakeRepoDir, "skills", "my-skill"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(fakeRepoDir, "skills", "my-skill", "SKILL.md"),
    "---\nname: my-skill\ndescription: A test skill\n---\n# My Skill\n"
  );

  await gitCommitAll(fakeRepoDir, "initial commit");
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fetchMarketplace — local file repo", () => {
  it("discovers skills from a local marketplace repo", async () => {
    const ref = parseMarketplaceReference(`file://${fakeRepoDir}`);
    expect(ref).not.toBeNull();

    const { skills, plugins } = await fetchMarketplace(ref!);

    expect(plugins.length).toBeGreaterThan(0);
    expect(plugins[0].name).toBe("test-plugin");

    expect(skills.size).toBe(1);
    expect(skills.has("my-skill")).toBe(true);

    const skill = skills.get("my-skill")!;
    expect(skill.plugin).toBe("test-plugin");
    expect(skill.sourceDir).toContain("my-skill");
  });

  it("returns a non-empty SHA", async () => {
    const ref = parseMarketplaceReference(`file://${fakeRepoDir}`)!;
    const { sha } = await fetchMarketplace(ref);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("fetchMarketplace — fallback to plugin.json", () => {
  let noMarketplaceDir: string;

  beforeAll(async () => {
    noMarketplaceDir = path.join(tmpDir, "single-plugin-repo");
    await initGitRepo(noMarketplaceDir);

    // Only plugin.json + skills — no marketplace.json
    await fs.mkdir(path.join(noMarketplaceDir, ".claude-plugin"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(noMarketplaceDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "standalone-plugin", version: "0.1.0" })
    );
    await fs.mkdir(
      path.join(noMarketplaceDir, "skills", "standalone-skill"),
      { recursive: true }
    );
    await fs.writeFile(
      path.join(
        noMarketplaceDir,
        "skills",
        "standalone-skill",
        "SKILL.md"
      ),
      "---\nname: standalone-skill\ndescription: Standalone\n---\n"
    );
    await gitCommitAll(noMarketplaceDir, "initial");
  });

  it("falls back to treating the repo as a single plugin", async () => {
    const ref = parseMarketplaceReference(`file://${noMarketplaceDir}`)!;
    const { skills, plugins } = await fetchMarketplace(ref);
    expect(plugins[0].name).toBe("standalone-plugin");
    expect(skills.has("standalone-skill")).toBe(true);
  });
});

describe("fetchMarketplace — marketplace at .claude-plugin/marketplace.json", () => {
  let altMarketplaceDir: string;

  beforeAll(async () => {
    altMarketplaceDir = path.join(tmpDir, "alt-marketplace-path");
    await initGitRepo(altMarketplaceDir);

    // Only put marketplace.json at .claude-plugin/marketplace.json
    await fs.mkdir(path.join(altMarketplaceDir, ".claude-plugin"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(altMarketplaceDir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        plugins: [
          { name: "alt-plugin", source: "." },
        ],
      })
    );
    await fs.mkdir(
      path.join(altMarketplaceDir, "skills", "alt-skill"),
      { recursive: true }
    );
    await fs.writeFile(
      path.join(altMarketplaceDir, "skills", "alt-skill", "SKILL.md"),
      "---\nname: alt-skill\n---\n"
    );
    await gitCommitAll(altMarketplaceDir, "initial");
  });

  it("finds marketplace.json at .claude-plugin/marketplace.json", async () => {
    const ref = parseMarketplaceReference(`file://${altMarketplaceDir}`)!;
    const { skills } = await fetchMarketplace(ref);
    expect(skills.has("alt-skill")).toBe(true);
  });
});
