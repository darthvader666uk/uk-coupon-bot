/**
 * GitHub API Writer
 * Reads/writes the uk-coupons.json file in the repo via GitHub REST API
 */
import { readFileSync, existsSync } from "fs";

const API_BASE = "https://api.github.com";

function getToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  // Try loading from .env file
  const envPath = new URL("../.env", import.meta.url).pathname;
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
  const content = Buffer.from(data.content, "base64").toString("utf8");
  return { json: JSON.parse(content), sha: data.sha };
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

  // First, get the current SHA (for update) or check if file exists
  let sha = null;
  try {
    const existing = await readJSON();
    sha = existing.sha;
  } catch {
    // File doesn't exist yet
  }

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
