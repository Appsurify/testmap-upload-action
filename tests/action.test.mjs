// node --test tests/  (Node >= 22; the action itself targets node24)
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { collectFiles, defaultTestrunName, interpretResponse, normalizeBaseUrl } from "../src/lib.mjs";

const ENTRY = fileURLToPath(new URL("../src/index.mjs", import.meta.url));

async function tmpTree(layout) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tm-action-"));
  for (const [rel, content] of Object.entries(layout)) {
    const p = path.join(root, rel);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content);
  }
  return root;
}

describe("collectFiles", () => {
  test("prefers the plugin ZIP over the per-test JSON in the same folder", async () => {
    const root = await tmpTree({
      "test-results/playwright/ui/ui-coverage-reports.zip": "zip",
      "test-results/playwright/ui/spec/chromium/a.json": "{}",
    });
    const { files } = await collectFiles(["test-results/playwright/ui"], root);
    assert.deepEqual(files.map((f) => path.relative(root, f)), [
      path.join("test-results/playwright/ui/ui-coverage-reports.zip"),
    ]);
  });

  test("falls back to JSON reports recursively and reports missing folders", async () => {
    const root = await tmpTree({
      "out/spec/chromium/b.json": "{}",
      "out/spec/firefox/a.json": "{}",
      "out/notes.txt": "x",
    });
    const { files, missing } = await collectFiles(["out", "test-results/cypress/ui"], root);
    assert.equal(files.length, 2);
    assert.ok(files.every((f) => f.endsWith(".json")));
    assert.deepEqual(missing, ["test-results/cypress/ui"]);
  });
});

describe("defaults and validation", () => {
  test("test run name from the workflow context", () => {
    assert.equal(
      defaultTestrunName({ GITHUB_WORKFLOW: "E2E", GITHUB_RUN_NUMBER: "42", GITHUB_REF_NAME: "main" }),
      "E2E #42 (main)",
    );
    assert.equal(
      defaultTestrunName({ GITHUB_WORKFLOW: "E2E", GITHUB_RUN_NUMBER: "7", GITHUB_RUN_ATTEMPT: "2", GITHUB_HEAD_REF: "feat/x", GITHUB_REF_NAME: "12/merge" }),
      "E2E #7.2 (feat/x)",
    );
  });

  test("rejects plain http to a remote host", () => {
    assert.throws(() => normalizeBaseUrl("http://acme.testmap.cloud"), /https/);
    assert.equal(normalizeBaseUrl("https://acme.testmap.cloud/some/path"), "https://acme.testmap.cloud");
  });
});

describe("interpretResponse", () => {
  test("PROJECT_NOT_FOUND arrives as HTTP 200 and still fails", () => {
    const v = interpretResponse({ status: 200, body: JSON.stringify({ success: false, code: "PROJECT_NOT_FOUND", message: "Project not found" }) });
    assert.equal(v.ok, false);
    assert.match(v.reason, /PROJECT_NOT_FOUND.*case-sensitive/);
  });

  test("success with per-report errors is a failure", () => {
    const v = interpretResponse({ status: 200, body: JSON.stringify({ success: true, data: { errors: ["bad report"] } }) });
    assert.equal(v.ok, false);
  });

  test("401 and non-JSON bodies", () => {
    assert.match(interpretResponse({ status: 401, body: '{"detail":"x"}' }).reason, /Token rejected/);
    assert.match(interpretResponse({ status: 502, body: "<html>Bad gateway</html>" }).reason, /HTTP 502/);
  });
});

// ------------------------------------------------------------- end to end

let server;
let baseUrl;
const received = [];
let nextResponse;

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    // Parse with the WHATWG multipart parser to prove the hand-built body is well-formed.
    const form = await new Request("http://mock/", {
      method: "POST",
      headers: { "content-type": req.headers["content-type"] },
      body: Buffer.concat(chunks),
    }).formData();
    received.push({ url: req.url, auth: req.headers.authorization, form });
    const { status, body } = nextResponse(form);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

function runAction(inputs, cwd) {
  const env = { PATH: process.env.PATH, GITHUB_WORKSPACE: cwd, GITHUB_WORKFLOW: "E2E", GITHUB_RUN_NUMBER: "5", GITHUB_REF_NAME: "main" };
  for (const [k, v] of Object.entries(inputs)) env[`INPUT_${k.toUpperCase()}`] = v;
  env.GITHUB_OUTPUT = path.join(cwd, "gh-output");
  env.GITHUB_STEP_SUMMARY = path.join(cwd, "gh-summary");
  return new Promise((resolve) => {
    execFile(process.execPath, [ENTRY], { env, cwd }, (err, stdout) =>
      resolve({ code: err ? err.code : 0, stdout, env }),
    );
  });
}

const okBody = (form) => ({
  status: 200,
  body: {
    success: true,
    data: {
      project_id: "p-1",
      run_id: "r-1",
      files_uploaded: form.getAll("files").length,
      testcases_imported: 3,
      errors: [],
      warnings: ["Skipped 2 non-addressable third-party UI element(s) — no impact on coverage"],
    },
  },
});

describe("action end to end (mock server)", () => {
  test("uploads the ZIP with the expected fields and writes outputs + summary", async () => {
    const cwd = await tmpTree({ "test-results/playwright/ui/ui-coverage-reports.zip": "PK-zip-bytes" });
    nextResponse = okBody;
    const r = await runAction({ url: baseUrl, token: "tmap_secret", project: "My Project", path: "test-results/playwright/ui" }, cwd);
    assert.equal(r.code, 0, r.stdout);
    const last = received.at(-1);
    assert.equal(last.url, "/api/v1/reports/import");
    assert.equal(last.auth, "Bearer tmap_secret");
    assert.equal(last.form.get("project_name"), "My Project");
    assert.equal(last.form.get("testrun_name"), "E2E #5 (main)");
    const [file] = last.form.getAll("files");
    assert.equal(file.name, "test-results__playwright__ui__ui-coverage-reports.zip");
    assert.equal(await file.text(), "PK-zip-bytes");
    assert.match(r.stdout, /::add-mask::tmap_secret/);
    const out = await readFile(r.env.GITHUB_OUTPUT, "utf8");
    assert.match(out, /testrun-id=r-1/);
    assert.match(out, new RegExp(`testrun-url=${baseUrl}/project/p-1/testrun/r-1`));
    assert.match(await readFile(r.env.GITHUB_STEP_SUMMARY, "utf8"), /Tests imported \| 3/);
  });

  test("PROJECT_NOT_FOUND fails the step by default", async () => {
    const cwd = await tmpTree({ "r/a.json": "{}" });
    nextResponse = () => ({ status: 200, body: { success: false, code: "PROJECT_NOT_FOUND", message: "Project not found" } });
    const r = await runAction({ url: baseUrl, token: "tmap_x", project: "my project", path: "r" }, cwd);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /::error::PROJECT_NOT_FOUND/);
  });

  test("fail-on-error=false downgrades the failure to a warning", async () => {
    const cwd = await tmpTree({ "r/a.json": "{}" });
    nextResponse = () => ({ status: 200, body: { success: false, code: "PROJECT_NOT_FOUND", message: "Project not found" } });
    const r = await runAction({ url: baseUrl, token: "tmap_x", project: "x", path: "r", "fail-on-error": "false" }, cwd);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /::warning::PROJECT_NOT_FOUND/);
  });

  test("missing token (fork PR) skips without calling the server", async () => {
    const cwd = await tmpTree({ "r/a.json": "{}" });
    const before = received.length;
    const r = await runAction({ url: baseUrl, token: "", project: "x", path: "r" }, cwd);
    assert.equal(r.code, 0);
    assert.equal(received.length, before);
    assert.match(r.stdout, /skipping upload/);
  });

  test("no reports: warn by default, error on request", async () => {
    const cwd = await tmpTree({ "empty/.keep": "" });
    const warn = await runAction({ url: baseUrl, token: "tmap_x", project: "x", path: "empty" }, cwd);
    assert.equal(warn.code, 0);
    assert.match(warn.stdout, /::warning::No Testmap reports found/);
    const err = await runAction({ url: baseUrl, token: "tmap_x", project: "x", path: "empty", "if-no-files-found": "error" }, cwd);
    assert.equal(err.code, 1);
  });

  test("unreachable server fails with a clear message", async () => {
    const cwd = await tmpTree({ "r/a.json": "{}" });
    const r = await runAction({ url: "http://127.0.0.1:1", token: "tmap_x", project: "x", path: "r" }, cwd);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /::error::Upload to Testmap failed/);
  });
});
