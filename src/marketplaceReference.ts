/**
 * Marketplace reference parser.
 * Modeled after VS Code's marketplaceReference.ts in
 * src/vs/workbench/contrib/chat/common/plugins/marketplaceReference.ts
 *
 * Handles the same URL formats VS Code accepts:
 *   owner/repo                                   GitHub shorthand
 *   owner/repo#v1.0.0                            GitHub shorthand with ref
 *   https://github.com/owner/repo.git            HTTPS git URL
 *   https://dev.azure.com/org/proj/_git/repo     Azure DevOps HTTPS
 *   git@ssh.dev.azure.com:v3/org/proj/repo       SCP-style SSH
 *   git@github.com:owner/repo.git#v1.0.0         SSH with ref
 *   file:///local/path                            Local filesystem
 */

export type MarketplaceReferenceKind = "githubShorthand" | "gitUri" | "localFileUri";

export interface MarketplaceReference {
  /** Original string as given by the user */
  rawValue: string;
  /** Human-readable label for logging/UI */
  displayLabel: string;
  /** URL to pass to git clone */
  cloneUrl: string;
  /** Lowercased, .git-normalized URL used for deduplication */
  canonicalId: string;
  kind: MarketplaceReferenceKind;
  /** Tag, branch name, or full SHA to check out after cloning */
  ref?: string;
  /** Path segments used to build the local cache directory */
  cacheSegments: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Replace characters invalid in a filesystem path segment with underscores */
export function sanitizeCacheSegment(s: string): string {
  return s.replace(/[\\/:*?"<>|@]/g, "_");
}

/**
 * Normalize a git clone URL to a canonical form for deduplication:
 * lowercase and always ending in .git
 */
function canonicalize(url: string): string {
  return url.toLowerCase().replace(/\.git$/, "") + ".git";
}

// ---------------------------------------------------------------------------
// Parser #1 — URI (file://, http://, https://, ssh://)
// ---------------------------------------------------------------------------

function parseUriReference(value: string): MarketplaceReference | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  // Strip #ref fragment before processing
  const ref = url.hash ? url.hash.slice(1) : undefined;
  url.hash = "";

  if (url.protocol === "file:") {
    const pathParts = url.pathname.split("/").filter(Boolean);
    return {
      rawValue: value,
      displayLabel: url.pathname,
      cloneUrl: value,
      canonicalId: value,
      kind: "localFileUri",
      ref,
      // Use path segments so different local paths get distinct cache dirs
      cacheSegments: ["local", ...pathParts].map(sanitizeCacheSegment),
    };
  }

  if (["http:", "https:", "ssh:"].includes(url.protocol)) {
    // Ensure the clone URL always ends with .git
    let cloneUrl = url.toString();
    if (!cloneUrl.endsWith(".git")) cloneUrl += ".git";

    const pathParts = url.pathname.replace(/^\//, "").split("/").filter(Boolean);
    const cacheSegments = [url.hostname, ...pathParts].map(sanitizeCacheSegment);

    return {
      rawValue: value,
      displayLabel: `${url.hostname}/${pathParts.join("/")}`,
      cloneUrl,
      canonicalId: canonicalize(cloneUrl),
      kind: "gitUri",
      ref,
      cacheSegments,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Parser #2 — SCP-style SSH  (user@host:path[.git][#ref])
// ---------------------------------------------------------------------------

function parseScpReference(value: string): MarketplaceReference | null {
  // Must contain @ before : and no protocol scheme
  const match = /^([^@:/]+@[^:]+):(.+?)(?:\.git)?(?:#(.+))?$/.exec(value);
  if (!match) return null;

  const [, userHost, repoPath, ref] = match;
  const cloneUrl = `${userHost}:${repoPath}.git`;
  const host = userHost.split("@").pop() ?? userHost;
  const pathParts = repoPath.split("/").filter(Boolean);

  return {
    rawValue: value,
    displayLabel: `${host}/${repoPath}`,
    cloneUrl,
    canonicalId: canonicalize(cloneUrl),
    kind: "gitUri",
    ref,
    cacheSegments: [host, ...pathParts].map(sanitizeCacheSegment),
  };
}

// ---------------------------------------------------------------------------
// Parser #3 — GitHub shorthand (owner/repo[#ref])
// ---------------------------------------------------------------------------

function parseGitHubShorthand(value: string): MarketplaceReference | null {
  // Must be exactly two path segments with no protocol or @
  const match = /^([\w.-]+)\/([\w.-]+)(?:#(.+))?$/.exec(value);
  if (!match) return null;

  const [, owner, repo, ref] = match;
  const cloneUrl = `https://github.com/${owner}/${repo}.git`;

  return {
    rawValue: value,
    displayLabel: `${owner}/${repo}`,
    cloneUrl,
    canonicalId: canonicalize(cloneUrl),
    kind: "githubShorthand",
    ref,
    cacheSegments: [
      "github.com",
      sanitizeCacheSegment(owner),
      sanitizeCacheSegment(repo),
    ],
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a marketplace reference string into a structured object.
 * Returns null if the string does not match any known format.
 */
export function parseMarketplaceReference(
  value: string
): MarketplaceReference | null {
  return (
    parseUriReference(value) ??
    parseScpReference(value) ??
    parseGitHubShorthand(value)
  );
}

/**
 * Merge two sets of marketplace references, with `primary` taking precedence
 * on canonical ID conflicts — matching VS Code's deduplication logic.
 */
export function deduplicateMarketplaceReferences(
  primary: MarketplaceReference[],
  secondary: MarketplaceReference[]
): MarketplaceReference[] {
  const seen = new Set(primary.map((r) => r.canonicalId));
  return [...primary, ...secondary.filter((r) => !seen.has(r.canonicalId))];
}
