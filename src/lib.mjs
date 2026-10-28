// Zero-dependency helpers for the Testmap upload action. Node >= 24 built-ins only,
// so the action ships without a bundling step and without third-party code.
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";

export const ZIP_NAME = "ui-coverage-reports.zip";

// ---------------------------------------------------------------- workflow I/O

export function getInput(name, env = process.env) {
  // The runner exposes `with:` values as INPUT_<NAME>, spaces become underscores.
  const key = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
  return (env[key] ?? "").trim();
}

export function getMultilineInput(name, env = process.env) {
  return getInput(name, env)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function getBooleanInput(name, fallback, env = process.env) {
  const raw = getInput(name, env).toLowerCase();
  if (!raw) return fallback;
  if (["true", "yes", "1"].includes(raw)) return true;
  if (["false", "no", "0"].includes(raw)) return false;
  throw new Error(`Input "${name}" must be true or false, got "${raw}"`);
}

function escapeData(s) {
  return String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export const log = {
  info: (msg) => process.stdout.write(`${msg}\n`),
  warning: (msg) => process.stdout.write(`::warning::${escapeData(msg)}\n`),
  error: (msg) => process.stdout.write(`::error::${escapeData(msg)}\n`),
  mask: (value) => value && process.stdout.write(`::add-mask::${escapeData(value)}\n`),
};

// ---------------------------------------------------------------- file discovery

async function statOrNull(p) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

async function listJsonRecursive(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => path.join(e.parentPath ?? e.path, e.name))
    .sort();
}

/**
 * Resolve the upload set. A folder with the plugin's ZIP contributes only the ZIP:
 * the ZIP already holds every per-test JSON, so sending both would import each test twice.
 */
export async function collectFiles(paths, cwd = process.cwd()) {
  const files = [];
  const missing = [];
  for (const p of paths) {
    const abs = path.resolve(cwd, p);
    const st = await statOrNull(abs);
    if (!st) {
      missing.push(p);
      continue;
    }
    if (st.isFile()) {
      if (abs.endsWith(".zip") || abs.endsWith(".json")) files.push(abs);
      continue;
    }
    const zip = path.join(abs, ZIP_NAME);
    if (await statOrNull(zip)) files.push(zip);
    else files.push(...(await listJsonRecursive(abs)));
  }
  return { files: [...new Set(files)], missing };
}

// ---------------------------------------------------------------- defaults

export function defaultTestrunName(env = process.env) {
  const workflow = env.GITHUB_WORKFLOW || "CI";
  const run = env.GITHUB_RUN_NUMBER ? ` #${env.GITHUB_RUN_NUMBER}` : "";
  const attempt = Number(env.GITHUB_RUN_ATTEMPT || 1) > 1 ? `.${env.GITHUB_RUN_ATTEMPT}` : "";
  const ref = env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME;
  const name = `${workflow}${run}${attempt}${ref ? ` (${ref})` : ""}`;
  return name.slice(0, 255); // TestRun.name is String(255)
}

export function normalizeBaseUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Input "url" is not a valid URL: "${raw}"`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`Input "url" must be http(s), got "${u.protocol}"`);
  }
  if (u.protocol === "http:" && !["localhost", "127.0.0.1"].includes(u.hostname)) {
    throw new Error('Input "url" must use https: the token would be sent in clear text');
  }
  return u.origin;
}

// ---------------------------------------------------------------- upload

/**
 * POST multipart/form-data to /api/v1/reports/import, streaming files from disk.
 * node:https instead of fetch: fetch (undici) gives up after 300 s without response
 * headers, while the import is synchronous and the gateway allows 600 s.
 */
export function postMultipart(
  { baseUrl, token, fields, files, timeoutSec },
  transport = { http, https },
) {
  const boundary = `----testmap${randomBytes(12).toString("hex")}`;
  const url = new URL("/api/v1/reports/import", baseUrl);
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  const fileParts = files.map((f) => {
    // Relative path keeps same-named reports from different folders apart.
    const filename = (f.name ?? path.basename(f.path)).replace(/["\\\r\n]/g, "_");
    const type = f.path.endsWith(".zip") ? "application/zip" : "application/json";
    return {
      head: Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\n` +
          `Content-Type: ${type}\r\n\r\n`,
      ),
      path: f.path,
      size: f.size,
    };
  });
  const tail = Buffer.from(`--${boundary}--\r\n`);
  const length =
    parts.reduce((n, b) => n + b.length, 0) +
    fileParts.reduce((n, p) => n + p.head.length + p.size + 2, 0) +
    tail.length;

  const lib = url.protocol === "https:" ? transport.https : transport.http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": length,
          "User-Agent": "testmap-upload-action/0.1",
        },
        timeout: timeoutSec * 1000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`No response within ${timeoutSec} s`)));
    req.on("error", reject);

    (async () => {
      for (const b of parts) req.write(b);
      for (const p of fileParts) {
        req.write(p.head);
        for await (const chunk of createReadStream(p.path)) {
          if (!req.write(chunk)) await new Promise((r) => req.once("drain", r));
        }
        req.write("\r\n");
      }
      req.end(tail);
    })().catch((e) => req.destroy(e));
  });
}

/**
 * Turn the HTTP result into a verdict. The endpoint answers HTTP 200 with
 * success=false for PROJECT_NOT_FOUND, and success=true with a non-empty
 * data.errors when individual reports failed, so the status code alone is not enough.
 */
export function interpretResponse({ status, body }) {
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    // fall through
  }
  if (status === 401) {
    return { ok: false, reason: "Token rejected (401): missing, invalid, expired or revoked." };
  }
  if (status === 404 && !json) {
    return { ok: false, reason: 'Endpoint not found (404): check the "url" input.' };
  }
  if (status === 413) {
    return { ok: false, reason: "Upload too large (413) for the server or gateway." };
  }
  if (status < 200 || status >= 300 || !json) {
    const detail = json?.message ?? json?.detail ?? body.slice(0, 300);
    return { ok: false, reason: `HTTP ${status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` };
  }
  if (json.success === false) {
    const hint =
      json.code === "PROJECT_NOT_FOUND"
        ? ' The "project" input must match the project name exactly (case-sensitive).'
        : "";
    return { ok: false, reason: `${json.code ?? "ERROR"}: ${json.message ?? "import failed"}.${hint}` };
  }
  const data = json.data ?? {};
  const errors = Array.isArray(data.errors) ? data.errors : [];
  return {
    ok: errors.length === 0,
    reason: errors.length ? `Import finished with ${errors.length} error(s): ${errors[0]}` : null,
    data,
  };
}

export function testrunUrl(baseUrl, data) {
  if (!data?.project_id || !data?.run_id) return "";
  return `${baseUrl}/project/${data.project_id}/testrun/${data.run_id}`;
}

export function summaryMarkdown({ project, testrunName, files, data, url, reason }) {
  const rows = [
    ["Project", project],
    ["Test run", url ? `[${testrunName}](${url})` : testrunName],
    ["Files uploaded", String(files.length)],
  ];
  if (data) {
    rows.push(
      ["Tests imported", String(data.testcases_imported ?? 0)],
      ["Pages / snapshots", `${data.pages_imported ?? 0} / ${data.snapshots_imported ?? 0}`],
      ["Elements", String(data.elements_imported ?? 0)],
      ["Duration", `${Number(data.import_duration_sec ?? 0).toFixed(1)} s`],
    );
  }
  const status = reason ? `:x: ${reason}` : ":white_check_mark: Uploaded";
  const lines = [`### Testmap UI coverage`, "", status, "", "| | |", "|---|---|"];
  for (const [k, v] of rows) lines.push(`| ${k} | ${String(v).replace(/\|/g, "\\|")} |`);
  for (const w of data?.warnings ?? []) lines.push("", `> :warning: ${w}`);
  return `${lines.join("\n")}\n`;
}
