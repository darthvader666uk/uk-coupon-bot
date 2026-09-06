/**
 * GitHub API Writer
 * Reads/writes the uk-coupons.json file in the repo via GitHub REST API
 */
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";

const API_BASE = "https://api.github.com";

function getToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  // Try loading from .env file
  // fileURLToPath, not .pathname: the latter yields "/C:/..." on Windows, which
  // existsSync then resolves against the drive root and never finds.
  const envPath = fileURLToPath(new URL("../.env", import.meta.url));
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf8");
    const match = content.match(/GITHUB_TOKEN=(.+)/);
    if (match) return match[1].trim();
  }
  return null;
}

function getRepo() {
  return process.env.GITHUB_REPO || "darthvader666uk/uk-coupon-bot";
}

function getBranch() {
  return process.env.GITHUB_BRANCH || "main";
}

const FILE_PATH = "data/uk-coupons.json";

/**
 * Read the current uk-coupons.json from the repo
 */
export async function readJSON() {
  const token = getToken();
  const repo = getRepo();
  const branch = getBranch();

  const url = `${API_BASE}/repos/${repo}/contents/${FILE_PATH}?ref=${branch}`;
  const headers = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "uk-coupon-bot",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    if (res.status === 404) {
      console.log("[GitHub] JSON file not found, starting fresh");
      return { json: { meta: { lastUpdated: new Date().toISOString(), totalCodes: 0, version: "1.0", sources: [] }, stores: {} }, sha: null };
    }
    throw new Error(`GitHub read failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  let content = data.content ? Buffer.from(data.content, "base64").toString("utf8") : "";

  if (!content && data.sha) {
    // The Contents API returns empty content for files over 1MB — which the
    // aggregate passed long ago. The Git blob API has no such limit.
    console.log(`[GitHub] File is ${data.size} bytes, reading via blob API`);
    const blobRes = await fetch(`${API_BASE}/repos/${repo}/git/blobs/${data.sha}`, { headers });
    if (!blobRes.ok) throw new Error(`GitHub blob read failed: ${blobRes.status} ${blobRes.statusText}`);
    const blob = await blobRes.json();
    content = Buffer.from(blob.content, "base64").toString("utf8");
  }

  if (!content) throw new Error("GitHub read returned empty content");
  return { json: JSON.parse(content), sha: data.sha };
}

/**
 * Fetch just the blob SHA for a path, without downloading or parsing it.
 * writeJSON needs the SHA to update an existing file; deriving it from a full
 * read meant an unreadable file produced a null SHA and a confusing
 * 422 "sha wasn't supplied" instead of a real error.
 */
export async function getFileSha(path) {
  const token = getToken();
  const repo = getRepo();
  const branch = getBranch();
  const headers = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "uk-coupon-bot",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}/repos/${repo}/contents/${path}?ref=${branch}`, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub SHA lookup failed for ${path}: ${res.status} ${res.statusText}`);
  return (await res.json()).sha;
}

/**
 * Write uk-coupons.json to the repo (creates or updates)
 */
export async function writeJSON(jsonData, commitMessage) {
  const token = getToken();
  if (!token) {
    console.log("[GitHub] No token, skipping write (dry run)");
    return null;
  }

  const repo = getRepo();
  const branch = getBranch();
  const content = JSON.stringify(jsonData, null, 2);

  // Metadata-only SHA lookup. Parsing the whole file just to learn its SHA
  // meant a file too large to parse produced sha=null and a 422.
  const sha = await getFileSha(FILE_PATH);

  const body = {
    message: commitMessage || `Update coupon database ${new Date().toISOString()}`,
    content: Buffer.from(content).toString("base64"),
    branch,
  };
  if (sha) body.sha = sha;

  const url = `${API_BASE}/repos/${repo}/contents/${FILE_PATH}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Accept: "application/vnd.github.v3+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "uk-coupon-bot",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub write failed: ${res.status} - ${err}`);
  }

  const result = await res.json();
  console.log(`[GitHub] Written to ${result.content?.html_url || "repo"}`);
  return result;
}

/**
 * Push many files in a single commit via the Git Data API.
 *
 * The Contents API writes one file per call and caps at 1MB. Now that the
 * database is sharded, a run touches the index, the aggregate, dead-codes and
 * every changed store file — pushing those one at a time would be dozens of
 * commits, and pushing only the aggregate would leave the shards stale, which
 * is what the userscript actually reads.
 *
 * Blobs -> tree -> commit -> update ref: four calls plus one per changed file,
 * landing as one atomic commit with no size limit.
 *
 * @param {Array<{path: string, content: string}>} files
 */
export async function pushFiles(files, commitMessage) {
  const token = getToken();
  if (!token) {
    console.log("[GitHub] No token, skipping push (dry run)");
    return null;
  }
  if (!files.length) {
    console.log("[GitHub] Nothing to push");
    return null;
  }

  const repo = getRepo();
  const branch = getBranch();
  const headers = {
    Accept: "application/vnd.github.v3+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "uk-coupon-bot",
  };

  const call = async (path, options = {}) => {
    const res = await fetch(`${API_BASE}/repos/${repo}${path}`, { headers, ...options });
    if (!res.ok) {
      throw new Error(`GitHub ${options.method || "GET"} ${path} failed: ${res.status} - ${(await res.text()).slice(0, 300)}`);
    }
    return res.json();
  };

  const ref = await call(`/git/ref/heads/${branch}`);
  const baseCommitSha = ref.object.sha;
  const baseCommit = await call(`/git/commits/${baseCommitSha}`);

  // Blobs first, so the tree can reference them by SHA.
  const tree = [];
  for (const file of files) {
    const blob = await call("/git/blobs", {
      method: "POST",
      body: JSON.stringify({ content: Buffer.from(file.content).toString("base64"), encoding: "base64" }),
    });
    tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const newTree = await call("/git/trees", {
    method: "POST",
    body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree }),
  });

  const commit = await call("/git/commits", {
    method: "POST",
    body: JSON.stringify({
      message: commitMessage || `Update coupon database ${new Date().toISOString()}`,
      tree: newTree.sha,
      parents: [baseCommitSha],
    }),
  });

  await call(`/git/refs/heads/${branch}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha }),
  });

  console.log(`[GitHub] Pushed ${files.length} file(s) as ${commit.sha.slice(0, 8)}`);
  return commit;
}

/**
 * Fetch all open issues labeled "failed-code" and extract code+store pairs
 */
export async function fetchFailedCodeIssues() {
  const token = getToken();
  if (!token) return [];

  const repo = getRepo();
  const url = `${API_BASE}/repos/${repo}/issues?labels=failed-code&state=open&per_page=100`;
  const headers = {
    Accept: "application/vnd.github.v3+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "uk-coupon-bot",
  };

  const res = await fetch(url, { headers });
  if (!res.ok) {
    console.log(`[GitHub] Failed to fetch failed-code issues: ${res.status}`);
    return [];
  }

  const issues = await res.json();
  const failed = [];

  for (const issue of issues) {
    // Parse code and store from title: "❌ Code failed: CODE @ STORE"
    const match = issue.title.match(/Code failed: (.+?) @ (.+)/);
    if (match) {
      failed.push({ code: match[1].trim(), storeDomain: match[2].trim(), issueNumber: issue.number });
    }
  }

  console.log(`[GitHub] Found ${failed.length} open failed-code issues`);
  return failed;
}

/**
 * Close a failed-code issue after the code has been removed
 */
export async function closeIssue(issueNumber) {
  const token = getToken();
  if (!token) return;

  const repo = getRepo();
  const url = `${API_BASE}/repos/${repo}/issues/${issueNumber}`;

  await fetch(url, {
    method: "PATCH",
    headers: {
      Accept: "application/vnd.github.v3+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "uk-coupon-bot",
    },
    body: JSON.stringify({ state: "closed" }),
  });
}

/**
 * Create a GitHub Issue for a failed code report
 */
export async function reportFailedCode(code, storeDomain, reason) {
  const token = getToken();
  if (!token) {
    console.log("[GitHub] No token, cannot create issue");
    return null;
  }

  const repo = getRepo();
  const url = `${API_BASE}/repos/${repo}/issues`;

  const body = {
    title: `❌ Code failed: ${code} @ ${storeDomain}`,
    body: [
      "## Failed Code Report",
      "",
      `- **Code:** \`${code}\``,
      `- **Store:** ${storeDomain}`,
      `- **Reason:** ${reason || "Not specified"}`,
      `- **Reported:** ${new Date().toISOString()}`,
      "",
      "This code was reported as not working via the Tampermonkey extension.",
    ].join("\n"),
    labels: ["failed-code"],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github.v3+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "uk-coupon-bot",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.log(`[GitHub] Issue creation failed: ${res.status}`);
    return null;
  }

  return res.json();
}
