// Entry point of the Testmap upload action (runs.using: node24).
import { appendFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  collectFiles,
  defaultTestrunName,
  getBooleanInput,
  getInput,
  getMultilineInput,
  interpretResponse,
  log,
  normalizeBaseUrl,
  postMultipart,
  summaryMarkdown,
  testrunUrl,
} from "./lib.mjs";

async function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  await appendFile(process.env.GITHUB_OUTPUT, `${name}=${String(value).replace(/\r?\n/g, " ")}\n`);
}

async function writeSummary(markdown) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
}

// Storage keys on the server are derived from the file name, so the name carries no
// path separators: test-results/playwright/ui/a/b.json -> test-results__playwright__ui__a__b.json
function uploadName(absPath, cwd) {
  const rel = path.relative(cwd, absPath);
  const safe = rel.startsWith("..") ? path.basename(absPath) : rel;
  return safe.split(path.sep).join("__");
}

async function run() {
  const failOnError = getBooleanInput("fail-on-error", true);
  const fail = (msg) => {
    if (failOnError) {
      log.error(msg);
      process.exitCode = 1;
    } else {
      log.warning(msg);
    }
  };

  const token = getInput("token");
  if (!token) {
    // Secrets are not passed to workflows triggered from forks: skip instead of breaking the PR.
    log.warning("No Testmap token provided (secrets are unavailable on fork pull requests); skipping upload.");
    return;
  }
  log.mask(token);

  const baseUrl = normalizeBaseUrl(getInput("url"));
  const project = getInput("project");
  if (!project) throw new Error('Input "project" is required');
  const testrunName = getInput("testrun-name") || defaultTestrunName();
  const timeoutSec = Number(getInput("timeout") || 600);
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new Error('Input "timeout" must be a positive number');

  const onMissing = (getInput("if-no-files-found") || "warn").toLowerCase();
  if (!["warn", "error", "ignore"].includes(onMissing)) {
    throw new Error('Input "if-no-files-found" must be warn, error or ignore');
  }

  const cwd = process.env.GITHUB_WORKSPACE || process.cwd();
  const { files } = await collectFiles(getMultilineInput("path"), cwd);
  if (files.length === 0) {
    const msg =
      "No Testmap reports found. Check that the rrweb plugin reporter is configured and the tests ran.";
    if (onMissing === "error") throw new Error(msg);
    if (onMissing === "warn") log.warning(msg);
    return;
  }

  const uploads = [];
  for (const f of files) uploads.push({ path: f, name: uploadName(f, cwd), size: (await stat(f)).size });
  const totalMb = uploads.reduce((n, f) => n + f.size, 0) / 1024 / 1024;
  log.info(`Uploading ${uploads.length} file(s), ${totalMb.toFixed(1)} MB, to ${baseUrl} as "${testrunName}"`);
  for (const f of uploads) log.info(`  ${path.relative(cwd, f.path)}`);

  // Single attempt on purpose: every call creates a new test run, so a retry after a
  // response was lost would create a duplicate run. See the design doc (idempotency key).
  let result;
  try {
    result = await postMultipart({
      baseUrl,
      token,
      fields: { project_name: project, testrun_name: testrunName },
      files: uploads,
      timeoutSec,
    });
  } catch (e) {
    fail(`Upload to Testmap failed: ${e.message}`);
    await writeSummary(summaryMarkdown({ project, testrunName, files: uploads, reason: e.message }));
    return;
  }

  const verdict = interpretResponse(result);
  const url = testrunUrl(baseUrl, verdict.data);
  if (verdict.data) {
    await setOutput("testrun-id", verdict.data.run_id ?? "");
    await setOutput("project-id", verdict.data.project_id ?? "");
    await setOutput("testrun-url", url);
    await setOutput("testcases-imported", verdict.data.testcases_imported ?? 0);
  }
  for (const w of verdict.data?.warnings ?? []) log.warning(w);
  await writeSummary(
    summaryMarkdown({ project, testrunName, files: uploads, data: verdict.data, url, reason: verdict.reason }),
  );

  if (!verdict.ok) {
    fail(verdict.reason);
    return;
  }
  log.info(`Imported ${verdict.data.testcases_imported ?? 0} test(s). ${url}`);
}

run().catch((e) => {
  log.error(e.message);
  process.exitCode = 1;
});
