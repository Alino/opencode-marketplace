import { describe, it, expect } from "bun:test";
import {
  parseMarketplaceReference,
  deduplicateMarketplaceReferences,
} from "../src/marketplaceReference.ts";

// ---------------------------------------------------------------------------
// parseMarketplaceReference
// ---------------------------------------------------------------------------

describe("parseMarketplaceReference", () => {
  // --- GitHub shorthand ---

  it("parses GitHub shorthand owner/repo", () => {
    const ref = parseMarketplaceReference("owner/repo");
    expect(ref).not.toBeNull();
    expect(ref!.kind).toBe("githubShorthand");
    expect(ref!.cloneUrl).toBe("https://github.com/owner/repo.git");
    expect(ref!.displayLabel).toBe("owner/repo");
    expect(ref!.ref).toBeUndefined();
    expect(ref!.canonicalId).toBe("https://github.com/owner/repo.git");
  });

  it("parses GitHub shorthand with ref", () => {
    const ref = parseMarketplaceReference("owner/repo#v1.0.0");
    expect(ref).not.toBeNull();
    expect(ref!.ref).toBe("v1.0.0");
    expect(ref!.cloneUrl).toBe("https://github.com/owner/repo.git");
  });

  it("parses GitHub shorthand with hyphenated names", () => {
    const ref = parseMarketplaceReference("my-org/my-repo#main");
    expect(ref).not.toBeNull();
    expect(ref!.cloneUrl).toBe("https://github.com/my-org/my-repo.git");
    expect(ref!.ref).toBe("main");
  });

  // --- HTTPS git URLs ---

  it("parses HTTPS GitHub URL", () => {
    const ref = parseMarketplaceReference("https://github.com/owner/repo.git");
    expect(ref).not.toBeNull();
    expect(ref!.kind).toBe("gitUri");
    expect(ref!.cloneUrl).toBe("https://github.com/owner/repo.git");
  });

  it("parses HTTPS URL without .git suffix and adds it", () => {
    const ref = parseMarketplaceReference("https://github.com/owner/repo");
    expect(ref).not.toBeNull();
    expect(ref!.cloneUrl).toBe("https://github.com/owner/repo.git");
  });

  it("parses Azure DevOps HTTPS URL", () => {
    const ref = parseMarketplaceReference(
      "https://dev.azure.com/my-org/my-project/_git/my-skills-repo"
    );
    expect(ref).not.toBeNull();
    expect(ref!.kind).toBe("gitUri");
    expect(ref!.cloneUrl).toContain("dev.azure.com");
    expect(ref!.cloneUrl).toEndWith(".git");
  });

  it("parses HTTPS URL with ref fragment", () => {
    const ref = parseMarketplaceReference(
      "https://github.com/owner/repo.git#v2.0.0"
    );
    expect(ref).not.toBeNull();
    expect(ref!.ref).toBe("v2.0.0");
    // Fragment must not appear in cloneUrl
    expect(ref!.cloneUrl).not.toContain("#");
  });

  // --- SCP-style SSH ---

  it("parses SCP-style SSH git@github.com:owner/repo.git", () => {
    const ref = parseMarketplaceReference("git@github.com:owner/repo.git");
    expect(ref).not.toBeNull();
    expect(ref!.kind).toBe("gitUri");
    expect(ref!.cloneUrl).toBe("git@github.com:owner/repo.git");
  });

  it("parses Azure DevOps SSH reference", () => {
    const ref = parseMarketplaceReference(
      "git@ssh.dev.azure.com:v3/my-org/my-project/my-skills-repo"
    );
    expect(ref).not.toBeNull();
    expect(ref!.kind).toBe("gitUri");
    expect(ref!.cloneUrl).toEndWith(".git");
  });

  it("parses SCP SSH with ref fragment", () => {
    const ref = parseMarketplaceReference(
      "git@github.com:owner/repo.git#v1.2.3"
    );
    expect(ref).not.toBeNull();
    expect(ref!.ref).toBe("v1.2.3");
  });

  // --- Local file URI ---

  it("parses file:// URI", () => {
    const ref = parseMarketplaceReference("file:///Users/dev/my-skills");
    expect(ref).not.toBeNull();
    expect(ref!.kind).toBe("localFileUri");
    expect(ref!.cloneUrl).toContain("file://");
  });

  // --- Invalid inputs ---

  it("returns null for empty string", () => {
    expect(parseMarketplaceReference("")).toBeNull();
  });

  it("returns null for a plain filename", () => {
    expect(parseMarketplaceReference("marketplace.json")).toBeNull();
  });

  it("returns null for three-segment path (not owner/repo)", () => {
    // parseGitHubShorthand requires exactly two segments
    expect(parseMarketplaceReference("a/b/c")).toBeNull();
  });

  // --- canonicalId deduplication ---

  it("produces the same canonicalId for .git and non-.git variant", () => {
    const a = parseMarketplaceReference("https://github.com/owner/repo.git");
    const b = parseMarketplaceReference("https://github.com/owner/repo");
    expect(a!.canonicalId).toBe(b!.canonicalId);
  });

  it("produces the same canonicalId regardless of case", () => {
    const a = parseMarketplaceReference("Owner/Repo");
    const b = parseMarketplaceReference("owner/repo");
    expect(a!.canonicalId).toBe(b!.canonicalId);
  });

  // --- cacheSegments ---

  it("returns sensible cacheSegments for GitHub shorthand", () => {
    const ref = parseMarketplaceReference("owner/repo");
    expect(ref!.cacheSegments).toEqual(["github.com", "owner", "repo"]);
  });

  it("replaces unsafe characters in cacheSegments", () => {
    const ref = parseMarketplaceReference(
      "https://dev.azure.com/org/project/_git/Repo.Name"
    );
    expect(ref).not.toBeNull();
    // colons, spaces, percent-encoded chars should be replaced with _
    for (const seg of ref!.cacheSegments) {
      expect(seg).not.toMatch(/[\\/:*?"<>|@]/);
    }
  });
});

// ---------------------------------------------------------------------------
// deduplicateMarketplaceReferences
// ---------------------------------------------------------------------------

describe("deduplicateMarketplaceReferences", () => {
  it("keeps primary when canonicalIds match", () => {
    const primary = [parseMarketplaceReference("owner/repo#v1")!];
    const secondary = [parseMarketplaceReference("owner/repo#v2")!];
    const result = deduplicateMarketplaceReferences(primary, secondary);
    expect(result).toHaveLength(1);
    expect(result[0].ref).toBe("v1");
  });

  it("merges non-conflicting references", () => {
    const primary = [parseMarketplaceReference("ownerA/repoA")!];
    const secondary = [parseMarketplaceReference("ownerB/repoB")!];
    const result = deduplicateMarketplaceReferences(primary, secondary);
    expect(result).toHaveLength(2);
  });

  it("handles empty arrays", () => {
    expect(deduplicateMarketplaceReferences([], [])).toHaveLength(0);
    const refs = [parseMarketplaceReference("owner/repo")!];
    expect(deduplicateMarketplaceReferences(refs, [])).toHaveLength(1);
    expect(deduplicateMarketplaceReferences([], refs)).toHaveLength(1);
  });
});
