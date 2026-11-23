const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { localPaths, validateLocalPaths, verifyLocalConfiguration } = require("../connectivity-local");
const { allowReadOnlyRequest } = require("../voice123-readonly");
const { extractAttachment } = require("../attachment-review");
const { appendClarification, currentProjectMaterial } = require("../clarification-log");
const { readCurrentClarification, sha256 } = require("../approval-evidence");

const target = "https://voice123.com/dashboard/invites";
const account = "https://voice123.com/api/users/me";

function isolated(filename, env, imports) {
  const fullPath = path.join(__dirname, "..", filename);
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(fullPath, "utf8"), {
    URL, module, __dirname: path.dirname(fullPath), process: { env, stdin: { isTTY: true }, stdout: { isTTY: true } }, console,
    require: dependency => {
      assert.ok(Object.hasOwn(imports, dependency), "Unexpected adapter: " + dependency);
      return imports[dependency];
    }
  }, { filename: fullPath });
  return module.exports;
}

test("connectivity loads only the guarded browser, readonly Sheets and STS identity adapters", async () => {
  const accesses = [];
  const env = {
    VOICE123_EMAIL: "fixture@example.invalid",
    GOOGLE_SHEET_ID: "fixture-sheet", GOOGLE_SERVICE_ACCOUNT_EMAIL: "fixture", GOOGLE_PRIVATE_KEY: "fixture",
    AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "fixture", AWS_SECRET_ACCESS_KEY: "fixture"
  };
  const service = isolated("connectivity-check.js", env, {
    "./connectivity-local": { verifyLocalConfiguration: async () => ({ checked: true }) },
    "./voice123-readonly": {
      connectReadOnly: async () => ({ close: async () => accesses.push("browser-closed") }),
      readOnlyPage: async (browser, url, options) => {
        assert.equal(url, target);
        assert.equal(options.connectivityOnly, true);
        return {
          waitForResponse: async predicate => {
            const response = { url: () => account, ok: () => true, request: () => ({ method: () => "GET" }),
              json: async () => ({ id: "fixture-secret", email: env.VOICE123_EMAIL }) };
            assert.equal(await predicate({ ...response, url: () => "https://example.invalid/api/users/me" }), false);
            assert.equal(await predicate({ ...response, json: async () => ({ id: "other", email: "other@example.invalid" }) }), false);
            assert.equal(await predicate(response), true);
            accesses.push("account-metadata");
            return response;
          },
          goto: async url => {
            assert.equal(url, target);
            accesses.push("dashboard-bootstrap");
            return { ok: () => true, url: () => target };
          }
        };
      }
    },
    "google-auth-library": { JWT: class {
      constructor(options) { assert.equal(options.scopes.join(" "), "https://www.googleapis.com/auth/spreadsheets.readonly"); }
      async request(options) {
        assert.equal(options.method, "GET");
        assert.equal(options.url, "https://sheets.googleapis.com/v4/spreadsheets/fixture-sheet?fields=spreadsheetId");
        accesses.push("spreadsheet-metadata");
        return { data: { spreadsheetId: "fixture-sheet" } };
      }
    } },
    "aws-sdk/clients/sts": class {
      constructor(options) { assert.equal(options.endpoint, "https://sts.us-east-1.amazonaws.com"); }
      getCallerIdentity() {
        accesses.push("sts-identity");
        return { promise: async () => ({ Account: "fixture-secret", Arn: "fixture-secret" }) };
      }
    }
  });
  const result = await service.runConnectivityCheck(env);
  assert.deepEqual(accesses, ["dashboard-bootstrap", "account-metadata", "browser-closed", "spreadsheet-metadata", "sts-identity"]);
  assert.equal(result.services.Voice123, "Verified");
  assert.equal(result.services.GoogleSheets, "Verified");
  assert.equal(result.services.AWSIdentity, "Verified");
  assert.match(result.services.ElevenLabs, /^Skipped/);
  assert.ok(!JSON.stringify(result).includes("fixture-secret"));
});

test("unsafe switches and broken local preflight stop before any connectivity or production adapter", async () => {
  let validations = 0;
  const { runConnectivityCheck } = isolated("connectivity-check.js", {}, {
    "./connectivity-local": { verifyLocalConfiguration: async () => { validations++; throw new Error("missing parser fixture"); } }
  });
  for (const env of [{ DRY_RUN: "false" }, { ENABLE_PAID_GENERATION: "true" }, { ENABLE_VOICE123_SUBMISSION: "true" }]) {
    await assert.rejects(runConnectivityCheck(env), /disabled production switches/);
  }
  assert.equal(validations, 0);
  await assert.rejects(runConnectivityCheck({}), /missing parser fixture/);
  assert.equal(validations, 1);
});

test("direct production entry points also reject generation and submission while dry-run is in effect", async () => {
  const env = { ENABLE_PAID_GENERATION: "true", ENABLE_VOICE123_SUBMISSION: "true" };
  const modules = {
    "node:path": path, "node:fs/promises": fs, "node:os": os, "node:crypto": require("node:crypto"),
    "./approval-evidence": require("../approval-evidence"), dotenv: { config() {} }, "fs-extra": {},
    "./voice123-projects": {}, "./approval-audio": {}, "./elevenlabs": {}, "./voice123-proposal-controls": {},
    "./worker-lock": { withWorkerLock: () => assert.fail("Worker started") }
  };
  for (const dryRun of [undefined, "true"]) {
    env.DRY_RUN = dryRun;
    await assert.rejects(isolated("elevenlabs.js", env, modules).generateAudio("synthetic", "dummy"), /disabled/);
    await assert.rejects(isolated("voice123-submission.js", env, modules).submitApprovedAudio("synthetic", "dummy"), /disabled/);
    await assert.rejects(isolated("upload.js", env, modules)([]), /disabled/);
  }
});

test("dry-run blocks explicit discovery, approval and persistence write requests", async () => {
  const env = { DRY_RUN: "true" };
  const modules = {
    path, "node:path": path, "node:fs/promises": fs, "node:os": os,
    "node:crypto": require("node:crypto"),
    "node:child_process": {}, "node:util": require("node:util"), "fs-extra": {},
    "./voice123-projects": {}, "./helpers": {}, "./approval-audio": {}, "./approval-evidence": {},
    "./browser": { connect: () => assert.fail("Browser opened") }, dotenv: { config() {} }
  };
  await assert.rejects(isolated("voice123.js", env, modules).checkInvites({ dryRun: false }), /persistence is disabled/);
  await assert.rejects(isolated("approval.js", env, modules)(["generation", "fixture", "2027-01-01"]), /writes are disabled/);
  await assert.rejects(isolated("persistence-test.js", env, modules).runPersistenceTest(["--write-needs-review"]), /writes are disabled/);
});

test("the Voice123 probe policy admits only the bootstrap navigation and account metadata read", () => {
  const allows = (url, method = "GET", navigation = false, type = "fetch") => allowReadOnlyRequest({
    url: () => url, method: () => method, isNavigationRequest: () => navigation, resourceType: () => type
  }, target, true);
  assert.equal(allows(target, "GET", true), true);
  assert.equal(allows(account), true);
  assert.equal(allows("https://voice123.com/assets/dashboard.js", "GET", false, "script"), true);
  for (const [url, method, navigation] of [
    [target + "?accept=1", "GET", true],
    [target, "POST", true],
    [target, "GET", false],
    [account, "GET", true],
    [account + "?action=accept", "GET", false],
    ["https://voice123.com/api/invites", "GET", false],
    ["https://voice123.com/messages", "GET", true],
    ["https://voice123.com/projects/SYNTH/fixture/specs", "GET", true],
    ["https://voice123.com/api/invites?action=accept", "GET", false],
    ["https://voice123.com/api/invitations", "POST", false],
    ["https://voice123.com/api/invites/accept-invite", "GET", false],
    ["https://voice123.com/api/messages/mark-read", "GET", false],
    ["https://voice123.com/attachments/script.xlsx", "GET", false],
    ["https://voice123.com/audio/synthetic.mp3", "GET", false],
    ["https://example.com/api/invites", "GET", false]
  ]) assert.equal(allows(url, method, navigation), false, url);
});

async function sandbox(t, interpreter = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "voice-otto-connectivity-fixture-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = await fs.realpath(directory);
  const paths = localPaths(root);
  for (const entry of [paths.VOICE_OTTO_ATTACHMENT_DIR, path.dirname(paths.VOICE_OTTO_CLARIFICATION_LOG),
    paths.VOICE_OTTO_CLARIFICATION_SOURCE_DIR]) await fs.mkdir(entry, { mode: 0o700 });
  await fs.writeFile(paths.VOICE_OTTO_CLARIFICATION_LOG, "", { mode: 0o600 });
  if (interpreter) {
    await promisify(execFile)("python3", ["-m", "venv", "--without-pip", path.join(root, "python")]);
  } else {
    await fs.mkdir(path.dirname(paths.ATTACHMENT_PYTHON), { recursive: true });
    await fs.writeFile(paths.ATTACHMENT_PYTHON, "", { mode: 0o700 });
  }
  return { root, paths };
}

test("path validation rejects temporary overrides and symlinked evidence", async t => {
  const { root, paths } = await sandbox(t);
  assert.deepEqual(await validateLocalPaths(paths, root), paths);
  await assert.rejects(validateLocalPaths({ ...paths, VOICE_OTTO_ATTACHMENT_DIR: os.tmpdir() }, root), /Invalid local configuration/);
  await assert.rejects(validateLocalPaths({ ...paths, VOICE_OTTO_CLARIFICATION_LOG: "journal.jsonl" }, root), /Invalid local configuration/);
  const move = paths.VOICE_OTTO_CLARIFICATION_SOURCE_DIR + "-moved";
  await fs.rename(paths.VOICE_OTTO_CLARIFICATION_SOURCE_DIR, move);
  await fs.symlink(move, paths.VOICE_OTTO_CLARIFICATION_SOURCE_DIR);
  await assert.rejects(validateLocalPaths(paths, root), /Unexpected local review directory/);
});

test("an isolated Python without pinned packages fails closed", async t => {
  const { root, paths } = await sandbox(t, true);
  await assert.rejects(verifyLocalConfiguration(paths, root), /missing pinned parser dependencies/);
});

test("offline extraction leaves attachment bytes unchanged and synthetic journal data stays isolated", async t => {
  const { root, paths } = await sandbox(t);
  const testFile = path.join(paths.VOICE_OTTO_ATTACHMENT_DIR, "fixture.txt");
  const bytes = Buffer.from("Recording script\nThis synthetic line is for testing only.\n");
  await fs.writeFile(testFile, bytes);
  assert.equal((await extractAttachment(testFile)).provenance.sha256, sha256(bytes));
  assert.deepEqual(await fs.readFile(testFile), bytes);

  const separateJournal = path.join(root, "synthetic.jsonl");
  const source = { filename: "fixture.txt", version: "1", sha256: sha256(bytes) };
  await appendClarification(separateJournal, {
    kind: "project-material", source: "fixture", observedProjectId: "SYNTH10C", timestamp: new Date().toISOString(),
    reviewer: "synthetic", verifiedSource: "fixture", reviewedThrough: null,
    script: { version: "1", sha256: sha256("synthetic") }, terms: source,
    attachments: [], agreementRequired: false, agreement: null
  }, [{ id: "SYNTH10C", title: "Synthetic project" }]);
  assert.equal((await currentProjectMaterial(separateJournal, "SYNTH10C")).projectId, "SYNTH10C");
  await assert.rejects(currentProjectMaterial(paths.VOICE_OTTO_CLARIFICATION_LOG, "SYNTH10C"), /No reviewed/);
  await assert.rejects(readCurrentClarification({ id: "fixture", url: "https://voice123.com/projects/OTHERSYNTH/example/specs" },
    { journal: separateJournal, sources: paths.VOICE_OTTO_CLARIFICATION_SOURCE_DIR }), /No reviewed/);
  assert.equal(await fs.readFile(paths.VOICE_OTTO_CLARIFICATION_LOG, "utf8"), "");
});

test("normal dry-run discovery rejects unsafe browser requests", () => {
  const project = "https://voice123.com/projects/ABC/example/specs";
  const allows = (url, method = "GET", navigation = false, type = "fetch", selected = target) =>
    allowReadOnlyRequest({
      url: () => url,
      method: () => method,
      isNavigationRequest: () => navigation,
      resourceType: () => type
    }, selected, false);

  assert.equal(allows(target, "GET", true), true);
  assert.equal(allows(project, "GET", true, "document", project), true);
  assert.equal(allows("https://voice123.com/assets/dashboard.js", "GET", false, "script"), true);
  assert.equal(allows("https://voice123.com/assets/dashboard.css", "GET", false, "stylesheet"), true);

  for (const [url, method, navigation, type] of [
    ["https://voice123.com/api/projects/details", "GET", false, "fetch"],
    ["https://voice123.com/api/invitations", "GET", false, "xhr"],
    ["https://voice123.com/api/projects/details?view=read", "GET", false, "fetch"],
    ["https://voice123.com/assets/dashboard.js", "GET", false, "fetch"],
    ["https://voice123.com/assets/dashboard.js", "HEAD", false, "script"],
    ["https://voice123.com/assets/dashboard.js", "OPTIONS", false, "script"],
    ["https://voice123.com/assets/dashboard.js?operation=accept", "GET", false, "script"],
    [target + "?accept=1", "GET", true],
    ["https://voice123.com/api/invites/accept-invite", "GET", false],
    ["https://voice123.com/api/messages/mark-read", "GET", false],
    ["https://voice123.com/api/proposals/submit", "GET", false],
    ["https://voice123.com/attachments/script.xlsx", "GET", false],
    ["https://example.com/api/invites", "GET", false],
    [target, "POST", true],
    ["https://voice123.com/messages", "GET", true]
  ]) {
    assert.equal(allows(url, method, navigation, type), false, url);
  }

  // Additional normal dry-run request-policy boundaries.
  assert.equal(allows("https://cdn.voice123.com/assets/dashboard.js", "GET", false, "script"), true);

  for (const [url, method, navigation, type] of [
    ["https://voice123.com.evil.example/assets/dashboard.js", "GET", false, "script"],
    ["https://user:pass@voice123.com/assets/dashboard.js", "GET", false, "script"],
    ["https://voice123.com/assets/dashboard.js#fragment", "GET", false, "script"],
    ["https://voice123.com/api/dashboard.js", "GET", false, "script"],
    ["https://voice123.com/proposals/dashboard.js", "GET", false, "script"],
    ["https://voice123.com/assets/dashboard.js", "POST", false, "script"],
    [target + "#fragment", "GET", true, "document"]
  ]) {
    assert.equal(allows(url, method, navigation, type), false, url);
  }

  assert.equal(allows("not a valid URL"), false);
});
