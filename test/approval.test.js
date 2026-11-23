const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const fs = require("node:fs/promises");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const evidence = require("../approval-evidence");
const { rights, sha256, transition, authorizeGeneration, authorizeSubmission } = evidence;
const { stageAudio } = require("../approval-audio");
const permitMock = {
  openPermit: async () => ({
    permit: { id: "fixture", trackingId: "tracking", projectId: "V123" }, claim: async () => {}, validate: async () => {}
  }),
  approvalBinding: require("../execution-permit").approvalBinding
};
const { appendClarification, currentProjectMaterial } = require("../clarification-log");

const text = "Here is the exact recording script to read in the approved voice.";
const inputs = { voice: "voice", model: "model", settings: { stability: 0.6 } };
const audio = Buffer.from("approved upload-ready audio");
const audioSha256 = sha256(audio);
const url = "https://voice123.com/projects/V123/fixture/specs";
const audioUrl = "https://storage.example/audition.mp3";
const base = { id: "tracking", url, status: "Needs Review", script: "MANUAL_REVIEW_REQUIRED" };
const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
const actor = reviewer => ({ reviewer, expiresAt });
const details = {
  ...actor("project-reviewer"), script: text, attachmentReview: { outcome: "none", reason: "No attachments listed" },
  revisionReview: { outcome: "new invitation", reason: "New invitation confirmed" },
  rights: Object.fromEntries(rights.map(flag => [flag, { outcome: "cleared", reason: "Written clearance verified" }]))
};
let clarificationDirectory;
let clarificationOptions;
before(async () => {
  clarificationDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "voice-otto-approval-clarification-"));
  const sources = path.join(clarificationDirectory, "sources");
  const projectDirectory = path.join(sources, "V123");
  const journal = path.join(clarificationDirectory, "clarifications.jsonl");
  await fs.mkdir(projectDirectory, { recursive: true });
  await fs.writeFile(path.join(projectDirectory, "terms.txt"), "Synthetic terms");
  await appendClarification(journal, {
    kind: "project-material", source: "fixture", observedProjectId: "V123",
    timestamp: new Date().toISOString(), reviewer: "fixture", verifiedSource: "synthetic specs",
    reviewedThrough: null, script: { version: "1", sha256: sha256(text) }, attachments: [],
    terms: { filename: "terms.txt", version: "1", sha256: sha256("Synthetic terms") },
    agreementRequired: false, agreement: null
  }, [{ id: "V123", title: "Synthetic approval" }]);
  clarificationOptions = { journal, sources };
  details.clarification = await currentProjectMaterial(journal, "V123");
});
after(async () => { if (clarificationDirectory) await fs.rm(clarificationDirectory, { recursive: true, force: true }); });
const names = { Status: "status", Script: "script", "Approval Evidence": "evidence", "Reviewed At": "reviewedAt",
  "Audio File URL": "audioUrl", "Voice Settings": "voiceSettings", Notes: "notes" };
const apply = (row, changes) => ({ ...row, ...Object.fromEntries(Object.entries(changes).map(([key, value]) => [names[key] || key, value])) });
const project = () => apply(base, transition(base, "project", details));
const generatedApproval = () => {
  const row = project();
  return apply(row, transition(row, "generation", { ...actor("generation-reviewer"), inputs }));
};
const pending = () => ({ ...generatedApproval(), status: "Pending Submission Approval", audioUrl, voiceSettings: JSON.stringify(inputs.settings) });
const submittedApproval = () => {
  const row = pending();
  return apply(row, transition(row, "submission", { ...actor("submission-reviewer"), audioSha256 }));
};

test("independent decisions bind reviewer, expiry, rights, exact script and project IDs", () => {
  const record = submittedApproval();
  const saved = JSON.parse(record.evidence);
  assert.equal(saved.version, 2);
  assert.equal(saved.voice123Id, "V123");
  assert.equal(saved.trackingId, "tracking");
  assert.deepEqual(["project", "generation", "submission"].map(stage => saved[stage].reviewer),
    ["project-reviewer", "generation-reviewer", "submission-reviewer"]);
  assert.ok(["project", "generation", "submission"].every(stage => saved[stage].at && saved[stage].expiresAt));
  assert.equal(authorizeGeneration(generatedApproval(), text, inputs).reviewer, "generation-reviewer");
  assert.equal(authorizeSubmission(record, audioSha256).approval.audioSha256, audioSha256);
  assert.throws(() => authorizeSubmission({ ...record, id: "different" }, audioSha256), /identity/);
  assert.throws(() => authorizeSubmission(record, audioSha256, { now: Date.parse(expiresAt) }), /expired/);
});

test("skipped stages, incomplete rights clearance and malformed or absent evidence fail closed", () => {
  assert.throws(() => transition(base, "generation", { ...actor("x"), inputs }));
  assert.throws(() => transition(project(), "submission", { ...actor("x"), audioSha256 }));
  for (const review of [{ ...details, rights: {} }, { ...details, attachmentReview: "" }, { ...details, revisionReview: "" }]) {
    assert.throws(() => transition(base, "project", review));
  }
  for (const invalid of [undefined, "{}", "{", JSON.stringify({ version: 999 })]) {
    assert.throws(() => authorizeSubmission({ ...submittedApproval(), evidence: invalid, reviewedAt: expiresAt }, audioSha256));
  }
  assert.throws(() => authorizeSubmission({ ...submittedApproval(), status: "Approved" }, audioSha256));
});

test("script, model, voice, settings, rights changes, and revocations remove authorization", () => {
  const generation = generatedApproval();
  for (const change of [{ ...inputs, model: "another" }, { ...inputs, voice: "other" },
    { ...inputs, settings: { stability: 0.7 } }]) {
    assert.throws(() => authorizeGeneration(generation, text, change), /changed/);
  }
  assert.throws(() => authorizeGeneration({ ...generation, script: text + " " }, text + " ", inputs));
  const approved = submittedApproval();
  const edited = JSON.parse(approved.evidence);
  edited.project.rights[rights[0]].reason = "New clearance";
  assert.throws(() => authorizeSubmission({ ...approved, evidence: JSON.stringify(edited) }, audioSha256), /changed/);
  for (const stage of ["project", "generation", "submission"]) {
    const revoked = apply(approved, transition(approved, stage, { reviewer: "revoker", revoke: true }));
    assert.throws(() => authorizeSubmission(revoked, audioSha256));
  }
  assert.throws(() => authorizeSubmission({ ...approved, voiceSettings: '{"stability":0.9}' }, audioSha256));
});

test("private staged copy hashes exact bytes and detects a changed file under the same filename", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voice-otto-fixture-"));
  const source = path.join(dir, "same.mp3");
  let staged;
  let changed;
  try {
    await fs.writeFile(source, audio);
    staged = await stageAudio(source);
    assert.equal(await staged.digest(), audioSha256);
    assert.notEqual(staged.file, source);
    await fs.writeFile(source, "different bytes");
    changed = await stageAudio(source);
    assert.throws(() => authorizeSubmission(submittedApproval(), sha256("different bytes")));
    assert.equal(await changed.digest(), sha256("different bytes"));
    assert.equal(await staged.digest(), audioSha256);
  } finally {
    await staged?.cleanup();
    await changed?.cleanup();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function load(file, env, mocks) {
  const filename = path.join(__dirname, "..", file);
  const fallback = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(filename, "utf8"), {
    module, Buffer, URL, __dirname: path.dirname(filename), process: { env },
    console: { log() {}, warn() {}, error() {} },
    require: key => key === "./worker-lock" ? { withWorkerLock: work => work() } :
      Object.hasOwn(mocks, key) ? mocks[key] : fallback(key)
  }, { filename });
  return module.exports;
}

test("direct generation cannot start or load AWS for a legacy or revoked approval", async () => {
  for (const row of [base, { ...generatedApproval(), evidence: "" }]) {
    const updates = [];
    const generation = load("elevenlabs.js", {
      DRY_RUN: "false", ENABLE_PAID_GENERATION: "true", ELEVENLABS_VOICE_ID: "voice", ELEVENLABS_MODEL_ID: "model"
    }, {
      "./execution-permit": permitMock,
      "./googleSheets": {
        getApprovalProject: async () => row,
        updateProject: async (id, fields) => { updates.push(fields); }
      },
      "./s3": { uploadFile: () => assert.fail("unexpected AWS call") }
    });
    await assert.rejects(generation.generateAudio(base.id, text), { name: "ApprovalError" });
    assert.equal(updates.length, 0);
  }
});

function uploader({ record = submittedApproval(), revokeAt, digest = audioSha256, confirmation = true,
  candidateState = "ready", resolvedStates = [], hasInvite = true } = {}) {
  let row = record;
  let reads = 0;
  const actions = [];
  const button = { evaluate: async evaluate => evaluate.toString().includes("innerText") ? "Accept Invite" : true, click: async () => actions.push("accept") };
  const input = { uploadFile: async file => actions.push(file), evaluate: async () => digest };
  const submit = { click: async () => actions.push("submit") };
  const page = {
    goto: async () => {}, url: () => url, $$: async () => hasInvite ? [button] : [],
    waitForFunction: async () => confirmation,
    evaluate: async (fn, pathname, mode) => mode === "state" ? candidateState : false,
    evaluateHandle: async () => {
      const state = resolvedStates.shift() || "ready";
      return {
        getProperty: async key => ({
          jsonValue: async () => state, asElement: () => key === "input" ? input : submit, dispose: async () => {}
        }),
        dispose: async () => {}
      };
    }
  };
  const options = {
    connect: async () => { actions.push("connect"); return { newPage: async () => page, close: async () => {} }; },
    handleLogin: async () => {}
  };
  const implementation = load("voice123-submission.js", { DRY_RUN: "false", ENABLE_VOICE123_SUBMISSION: "true" }, {
    "./execution-permit": permitMock,
    "./recovery-manifest": { createRecoveryAttempt: () => async () => {} },
    "./elevenlabs": { generationInputs: () => inputs },
    "./approval-evidence": { ...evidence, verifyCurrentProjectReview: (current, review) =>
      evidence.verifyCurrentProjectReview(current, review, clarificationOptions) },
    "./approval-audio": { stageAudio: async () => ({ file: "/private/staged.mp3", digest: async () => digest, cleanup: async () => {} }) },
    "./googleSheets": {
      getApprovalProject: async () => {
        if (++reads === revokeAt) row = apply(row, transition(row, "submission", { reviewer: "revoker", revoke: true }));
        return row;
      },
      updateProject: async (id, changes) => { row = apply(row, changes); }
    }
  });
  const service = load("voice123.js", {}, {
    "./browser": { connect: options.connect },
    "./voice123-submission": { submitApprovedAudio: (projectUrl, file) => implementation.submitApprovedAudio(projectUrl, file, options) }
  });
  return { actions, row: () => row, run: () => service.uploadAudio(url, "/original/same.mp3") };
}

test("direct upload rejects legacy approval and modified audio before opening the browser", async () => {
  for (const runtime of [uploader({ record: { ...submittedApproval(), status: "Approved", evidence: "" } }),
    uploader({ digest: sha256("different") })]) {
    await assert.rejects(runtime.run(), { name: "ApprovalError" });
    assert.deepEqual(runtime.actions, []);
  }
});

test("fresh approval is required before acceptance, attachment and the final click", async () => {
  for (const [revokeAt, expected] of [
    [2, ["connect"]],
    [3, ["connect", "accept"]],
    [4, ["connect", "accept", "/private/staged.mp3"]],
    [5, ["connect", "accept", "/private/staged.mp3"]]
  ]) {
    const runtime = uploader({ revokeAt });
    await assert.rejects(runtime.run(), { name: "ApprovalError" });
    assert.deepEqual(runtime.actions, expected);
  }
});

test("confirmed submission uploads the staged file; ambiguous submission is never retried", async () => {
  const success = uploader();
  assert.equal(await success.run(), true);
  assert.equal(success.row().status, "Uploaded");
  assert.deepEqual(success.actions, ["connect", "accept", "/private/staged.mp3", "submit"]);
  const ambiguous = uploader({ confirmation: false });
  await assert.rejects(ambiguous.run(), /uncertain/);
  assert.equal(ambiguous.row().status, "Submission Uncertain");
  await assert.rejects(ambiguous.run(), { name: "ApprovalError" });
  assert.equal(ambiguous.actions.filter(action => action === "submit").length, 1);
});

test("Sheets reads fail closed for a missing migration column or a conflicting project record", async () => {
  const row = {
    get: field => ({
      "Project ID": base.id, "Project URL": url, Status: "Needs Review", Script: base.script
    })[field]
  };
  const sheet = {
    headerValues: ["Project ID", "Project URL", "Reviewed At", "Uploaded At", "Notes"],
    getRows: async () => [row]
  };
  const sheets = load("googleSheets.js", {
    GOOGLE_SHEET_ID: "mock", GOOGLE_SERVICE_ACCOUNT_EMAIL: "mock", GOOGLE_PRIVATE_KEY: "mock"
  }, {
    "google-spreadsheet": { GoogleSpreadsheet: class {
      sheetsByIndex = [sheet];
      async loadInfo() {}
    } },
    "google-auth-library": { JWT: class {} },
    dotenv: { config() {} },
    "./helpers": { retry: callback => callback() }
  });
  await assert.rejects(sheets.getApprovalProject({ id: base.id }), /Missing approval column: Approval Evidence/);
  sheet.headerValues.push("Approval Evidence");
  assert.equal((await sheets.getApprovalProject({ id: base.id })).id, base.id);
  sheet.getRows = async () => [row, { get: field => field === "Project ID" ? "other" : row.get(field) }];
  await assert.rejects(sheets.getApprovalProject({ id: base.id, voice123Id: "V123" }), /conflicting/);
});

test("unknown layouts and disabled controls block attachment and submission", async () => {
  const unknown = uploader({ candidateState: "unknown-layout" });
  await assert.rejects(unknown.run(), /unknown-layout/);
  assert.deepEqual(unknown.actions, ["connect"]);

  const locked = uploader({ candidateState: "disabled", resolvedStates: ["disabled"], hasInvite: false });
  await assert.rejects(locked.run(), /disabled/);
  assert.deepEqual(locked.actions, ["connect"]);

  const changed = uploader({ resolvedStates: ["ready", "ready", "disabled"] });
  await assert.rejects(changed.run(), /disabled/);
  assert.equal(changed.row().status, "Submission Uncertain");
  assert.deepEqual(changed.actions, ["connect", "accept", "/private/staged.mp3"]);
});

test("revision approval cannot start the new-invitation uploader", async () => {
  const reviewed = apply(base, transition(base, "project", {
    ...details, revisionReview: { outcome: "resolved", reason: "Revision checked" }
  }));
  const generation = apply(reviewed, transition(reviewed, "generation", { ...actor("generation-reviewer"), inputs }));
  const row = { ...generation, status: "Pending Submission Approval", audioUrl, voiceSettings: JSON.stringify(inputs.settings) };
  const revision = uploader({ record: apply(row, transition(row, "submission", { ...actor("submission-reviewer"), audioSha256 })) });
  await assert.rejects(revision.run(), /Revision submissions require separate manual handling/);
  assert.deepEqual(revision.actions, []);
});
