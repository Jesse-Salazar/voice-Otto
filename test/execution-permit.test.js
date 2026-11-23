const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { issuePermit, openPermit, revokePermit, reconcilePermit } = require("../execution-permit");

const binding = {
  projectId: "SYNTHPERMIT", trackingId: "synthetic-track", approvalSha256: "a".repeat(64),
  clarificationSha256: "b".repeat(64), audioSha256: "c".repeat(64)
};
async function fixture(t, operation = "submission") {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "voice-otto-permit-test-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const directory = path.join(await fs.realpath(tmp), "permits");
  const expected = { ...binding, audioSha256: operation === "submission" ? binding.audioSha256 : null };
  const input = { ...expected, operation, operator: "fixture human", authorization: "synthetic-only decision",
    expiresAt: new Date(Date.now() + 600000).toISOString() };
  const issue = () => issuePermit(input, { directory });
  const permit = await issue();
  const open = (scope = operation, clock) => openPermit(scope, { directory, permitId: permit.id, clock });
  return { permit, expected, input, directory, issue, open, operation };
}

test("execution permits bind operation, project, tracking ID, exact evidence and submission bytes", async t => {
  const f = await fixture(t);
  const handle = await f.open();
  await handle.validate(f.expected);
  for (const fields of [
    { projectId: "OTHERSYNTH" }, { trackingId: undefined }, { trackingId: "other-track" },
    { approvalSha256: "d".repeat(64) }, { clarificationSha256: "e".repeat(64) }, { audioSha256: "0".repeat(64) }
  ]) {
    await assert.rejects(handle.claim({ ...f.expected, ...fields }, randomUUID()), /does not match/);
  }
  await assert.rejects(f.open("generation"), /operation/);
  await assert.rejects(openPermit("submission", { directory: f.directory, permitId: "" }), /valid execution permit ID/);
  await assert.rejects(f.issue(), /already exists/);
  await assert.rejects(issuePermit({ ...f.input, trackingId: "" }, { directory: f.directory }), /Malformed/);
  await assert.rejects(issuePermit({ ...f.input, audioSha256: null }, { directory: f.directory }), /Malformed/);
});

test("expiration and revocation are checked before and during the claimed attempt", async t => {
  const f = await fixture(t, "generation");
  await assert.rejects(f.open("generation", () => Date.parse(f.permit.expiresAt)), /expired/);
  const handle = await f.open();
  const attempt = randomUUID();
  await handle.claim(f.expected, attempt);
  await handle.validate(f.expected, attempt);
  await assert.rejects(handle.validate(f.expected, randomUUID()), /claim does not match/);
  await assert.rejects(f.open(), /consumed/);
  await revokePermit(f.permit.id, { operator: "fixture", authorization: "revocation fixture" }, f.directory);
  await assert.rejects(handle.validate(f.expected, attempt), /revoked/);
  await assert.rejects(f.issue(), /manual reconciliation/);
});

test("an interrupted claim stays consumed and replacement needs a verified human outcome", async t => {
  const f = await fixture(t, "discovery");
  const child = async (action) => promisify(execFile)(process.execPath, ["-e", `
    const {openPermit}=require('./execution-permit');
    const [directory,permitId,raw,action]=process.argv.slice(1);
    (async()=>{const p=await openPermit('discovery',{directory,permitId});
      if(action==='before') process.kill(process.pid,'SIGKILL');
      await p.claim(JSON.parse(raw),require('node:crypto').randomUUID());
      process.kill(process.pid,'SIGKILL');
    })().catch(()=>process.exit(2));
  `, f.directory, f.permit.id, JSON.stringify(f.expected), action], { cwd: path.join(__dirname, "..") });
  await assert.rejects(child("before"), { signal: "SIGKILL" });
  await (await f.open()).validate(f.expected);
  await assert.rejects(child("after"), { signal: "SIGKILL" });
  await assert.rejects(f.open(), /consumed/);
  await assert.rejects(f.issue(), /manual reconciliation/);
  await assert.rejects(reconcilePermit(f.permit.id, { operator: "fixture", authorization: "known source",
    outcome: "uncertain" }, f.directory), /verified human reconciliation/);
  await reconcilePermit(f.permit.id, { operator: "fixture", authorization: "verified synthetic no-action receipt",
    outcome: "confirmed-no-action" }, f.directory);
  assert.notEqual((await f.issue()).id, f.permit.id);
  await assert.rejects(f.open(), /consumed/);
});

test("exactly one independent process can durably claim a permit", async t => {
  const f = await fixture(t, "generation");
  const compete = () => promisify(execFile)(process.execPath, ["-e", `
    const {openPermit}=require('./execution-permit');
    const [directory,permitId,raw]=process.argv.slice(1);
    (async()=>{const p=await openPermit('generation',{directory,permitId});
      await p.claim(JSON.parse(raw),require('node:crypto').randomUUID());
    })().catch(()=>process.exit(2));
  `, f.directory, f.permit.id, JSON.stringify(f.expected)], { cwd: path.join(__dirname, "..") });
  const outcomes = await Promise.allSettled([compete(), compete(), compete()]);
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(result => result.status === "rejected" && result.reason.code === 2).length, 2);
});

test("a torn claim or changed permit record fails closed", async t => {
  const f = await fixture(t);
  const handle = await f.open();
  await fs.writeFile(path.join(f.directory, f.permit.id + ".claim"), "", { mode: 0o600 });
  await assert.rejects(handle.validate(f.expected), /Malformed permit store record/);
  await assert.rejects(f.issue(), /Malformed permit store record/);
  const next = await fixture(t, "discovery");
  const original = await next.open();
  await fs.writeFile(path.join(next.directory, next.permit.id + ".permit"), JSON.stringify({
    ...next.permit, authorization: "changed after open"
  }));
  await assert.rejects(original.validate(next.expected), /permit changed/);
});

function isolated(filename, modules, env = {}) {
  const vm = require("node:vm");
  const module = { exports: {} };
  const source = require("node:fs").readFileSync(path.join(__dirname, "..", filename), "utf8");
  vm.runInNewContext(source, {
    module, URL, process: { env: { DRY_RUN: "false", ENABLE_PAID_GENERATION: "true", ENABLE_VOICE123_SUBMISSION: "true", ...env } },
    require: key => {
      assert.ok(Object.hasOwn(modules, key), "Unexpected adapter: " + key);
      return modules[key];
    }
  });
  return module.exports;
}

test("queued commands select only the named tracking ID even with another eligible row", async () => {
  const calls = [];
  const chosenUrl = "https://voice123.com/projects/SYNTHPERMIT/fixture/specs";
  const candidates = [
    { id: "other-track", url: "https://voice123.com/projects/OTHERSYNTH/fixture/specs", script: "other" },
    { id: binding.trackingId, url: chosenUrl, script: "fixture" }
  ];
  const modules = {
    dotenv: { config() {} }, "./validateEnv": () => {},
    "./execution-permit": {
      openPermit: async operation => ({ permit: { ...binding, operation: operation || "generation" } })
    },
    "./googleSheets": {
      getProjectsByStatus: () => assert.fail("Bulk selection bypassed the permit"),
      getApprovalProject: async ({ id, voice123Id }) => {
        assert.equal(id, binding.trackingId);
        assert.equal(voice123Id, binding.projectId);
        return candidates.find(row => row.id === id);
      }
    },
    "./elevenlabs": { generateAudio: async (...args) => calls.push(args) },
    "./voice123": {
      checkInvites: () => assert.fail("Generation permit authorized discovery"),
      uploadAudio: async (...args) => calls.push(args)
    }
  };
  await isolated("main.js", modules)();
  await isolated("upload.js", modules)([]);
  await assert.rejects(isolated("upload.js", modules)(["--local", "other-track", "/tmp/synthetic.wav"]), /another tracking ID/);
  assert.deepEqual(calls, [[binding.trackingId, "fixture"], [chosenUrl]]);
});

test("direct paid entry points without a permit stop before reading external adapters", async () => {
  const common = {
    "node:path": path, "node:fs/promises": fs, "node:os": os, "node:crypto": require("node:crypto"),
    "fs-extra": {}, "./approval-evidence": {}, "./approval-audio": {}, "./elevenlabs": {},
    "./voice123-proposal-controls": {}, "./worker-lock": { withWorkerLock: fn => fn() },
    "./voice123-projects": require("../voice123-projects"),
    "./execution-permit": { openPermit: operation => openPermit(operation, { permitId: "" }) }
  };
  await assert.rejects(isolated("elevenlabs.js", common).generateAudio(binding.trackingId, "fixture"), /permit ID is required/);
  await assert.rejects(isolated("voice123-submission.js", common).submitApprovedAudio(
    "https://voice123.com/projects/SYNTHPERMIT/fixture/specs", "/tmp/synthetic.wav", {}
  ), /permit ID is required/);
});
