const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const evidence = require("../approval-evidence");
const { appendClarification, currentProjectMaterial } = require("../clarification-log");

const projectId = "CLARIFY1";
const otherId = "CLARIFY2";
const registry = [
  { id: projectId, title: "Synthetic audition", threads: [{ source: "fixture", id: "thread-a" }] },
  { id: otherId, title: "Separate synthetic audition", threads: [{ source: "fixture", id: "thread-b" }] }
];
const script = "Narrator: A lantern keeps the shoreline visible.";
const terms = "Synthetic project terms";
const agreement = "Synthetic TTS agreement";
const audio = Buffer.from("dummy upload-ready audio bytes");
const hash = evidence.sha256;
const base = { id: "tracking-fixture", url: "https://voice123.com/projects/CLARIFY1/synthetic/specs", status: "Needs Review" };
const env = { DRY_RUN: "false", ENABLE_PAID_GENERATION: "true", ENABLE_VOICE123_SUBMISSION: "true", ELEVENLABS_VOICE_ID: "voice-fixture" };
const inputs = { voice: "voice-fixture", model: "eleven_multilingual_v2",
  settings: { stability: 0.6, similarity_boost: 0.85, style: 0.5, speed: 1.12, speaker_boost: true } };
const decision = reviewer => ({ reviewer, expiresAt: new Date(Date.now() + 600000).toISOString() });
const humanReview = {
  attachmentReview: { outcome: "none", reason: "Synthetic fixture has no recording attachments" },
  revisionReview: { outcome: "new invitation", reason: "Synthetic invitation" },
  rights: Object.fromEntries(evidence.rights.map(flag => [flag, { outcome: "cleared", reason: "Synthetic human review" }]))
};
const fields = { Status: "status", Script: "script", "Approval Evidence": "evidence", "Voice Settings": "voiceSettings",
  "Audio File URL": "audioUrl", Notes: "notes" };
const apply = (row, values) => ({ ...row, ...Object.fromEntries(Object.entries(values).map(([k, v]) => [fields[k] || k, v])) });
const version = (v, data) => ({ version: v, sha256: hash(data) });
const source = (filename, v, data) => ({ filename, ...version(v, data) });

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "voice-otto-clarification-gates-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sources = path.join(directory, "sources");
  const projectDirectory = path.join(sources, projectId);
  const journal = path.join(directory, "clarification.jsonl");
  const options = { journal, sources };
  await fs.mkdir(projectDirectory, { recursive: true });
  const put = (name, content) => fs.writeFile(path.join(projectDirectory, name), content);
  await put("terms.txt", terms);
  await put("agreement.txt", agreement);
  const common = { timestamp: new Date().toISOString(), source: "fixture" };
  const material = {
    ...common, kind: "project-material", observedProjectId: projectId, threadId: "thread-a",
    reviewer: "source-reviewer", verifiedSource: "synthetic source packet", reviewedThrough: null,
    script: version("1", script), terms: source("terms.txt", "1", terms), attachments: [],
    agreementRequired: true, agreement: source("agreement.txt", "1", agreement)
  };
  const record = input => appendClarification(journal, input, registry);
  await record(material);
  const response = {
    ...common, kind: "message", threadId: "thread-a", messageId: "reply-one", direction: "inbound", text: "Clarification",
    sender: { id: "synthetic-client", verification: "verified" }, recipient: { id: "synthetic-reviewer", verification: "verified" }
  };
  const current = () => currentProjectMaterial(journal, projectId);
  const verify = row => evidence.verifyCurrentProjectReview(row, evidence.parseEvidence(row).project, options);
  return { journal, options, put, record, material, response, current, verify };
}

function projectApproval(binding, requestedScript = script) {
  return apply(base, evidence.transition(base, "project", {
    ...humanReview, ...decision("project-reviewer"), clarification: binding, script: requestedScript
  }));
}
function generationApproval(project) {
  return apply(project, evidence.transition(project, "generation", { ...decision("generation-reviewer"), inputs }));
}
function submissionApproval(generation) {
  const pending = { ...generation, status: "Pending Submission Approval",
    voiceSettings: JSON.stringify(inputs.settings), audioUrl: "https://fixture.invalid/dummy.mp3" };
  return apply(pending, evidence.transition(pending, "submission", { ...decision("submission-reviewer"), audioSha256: hash(audio), inputs }));
}

test("current project source enables independent decisions, duplicate and unrelated replies leave its snapshot intact", async t => {
  const fixture = await setup(t);
  const initial = await fixture.current();
  const reviewed = projectApproval(initial);
  const generation = generationApproval(reviewed);
  const submission = submissionApproval(generation);
  await fixture.verify(submission);
  assert.throws(() => evidence.authorizeSubmission(generation, hash(audio)), /requires explicit approval/);
  assert.equal(evidence.authorizeSubmission(submission, hash(audio), { inputs }).approval.reviewer, "submission-reviewer");
  const unrelated = { ...fixture.response, threadId: "thread-b" };
  await fixture.record(unrelated);
  assert.equal((await fixture.record(unrelated)).appended, false);
  assert.equal((await fixture.current()).snapshotHash, initial.snapshotHash);
  await fixture.verify(submission);
  assert.throws(() => projectApproval({ ...initial, projectId: otherId }), /different project/);
  assert.throws(() => projectApproval(initial, script + " changed"), /different project or script/);
  assert.throws(() => projectApproval({ ...initial, attachments: [source("other.txt", "1", "unrelated")] }), /manifest differs/);
});

test("new messages and changed agreement hashes invalidate prior decisions until fresh human review", async t => {
  const fixture = await setup(t);
  const original = submissionApproval(generationApproval(projectApproval(await fixture.current())));
  const replacement = "Revised synthetic agreement, same filename";
  const message = { ...fixture.response, agreement: version("2", replacement) };
  const reply = await fixture.record(message);
  assert.equal(reply.record.event.reviewStatus, "Needs Review");
  assert.equal((await fixture.record(message)).appended, false);
  await assert.rejects(fixture.verify(original), /fresh project review/);
  await assert.rejects(fixture.record({ ...fixture.material, reviewedThrough: reply.record.hash }), /omits or conflicts/);
  await fixture.put("agreement.txt", replacement);
  const updatedScript = script + " The tide is turning.";
  await fixture.record({ ...fixture.material, reviewedThrough: reply.record.hash,
    agreement: source("agreement.txt", "2", replacement), script: version("2", updatedScript) });
  await assert.rejects(fixture.verify(original), /material changed/);
  const renewed = projectApproval(await fixture.current(), updatedScript);
  await fixture.verify(renewed);
  assert.equal(renewed.status, "Project Reviewed");
  assert.throws(() => evidence.authorizeGeneration(renewed, updatedScript, inputs));
  assert.throws(() => evidence.authorizeSubmission(renewed, hash(audio)));
  assert.throws(() => evidence.authorizeSubmission(original, hash(audio), { inputs: { ...inputs, model: "changed" } }), /changed/);
});

test("ambiguous identity requires recorded human verification and changed attachment metadata cannot be omitted", async t => {
  const fixture = await setup(t);
  const reply = await fixture.record({ ...fixture.response, sender: { verification: "ambiguous" },
    attachments: [source("script.xlsx", "2", "synthetic workbook replacement")] });
  await assert.rejects(fixture.record({ ...fixture.material, reviewedThrough: reply.record.hash }), /Unresolved sender/);
  const resolution = {
    kind: "identity-resolution", source: "fixture", threadId: "thread-a", timestamp: fixture.response.timestamp,
    messageHash: reply.record.hash, reviewer: "human-verifier", verifiedSource: "synthetic participant record",
    sender: fixture.response.sender, recipient: fixture.response.recipient
  };
  await assert.rejects(fixture.record({ ...resolution, threadId: "thread-b" }), /cross-project/);
  const verified = await fixture.record(resolution);
  await assert.rejects(fixture.record({ ...fixture.material, reviewedThrough: reply.record.hash }), /unreviewed clarifications/);
  await assert.rejects(fixture.record({ ...fixture.material, reviewedThrough: verified.record.hash }), /omits or conflicts/);
  await fixture.record({ ...fixture.material, reviewedThrough: verified.record.hash, attachments: reply.record.event.attachments });
  await assert.rejects(async () => projectApproval(await fixture.current()), /manifest differs/);
});

test("changed local terms, missing agreement, journal edits and journal rollback fail closed", async t => {
  const fixture = await setup(t);
  const approved = projectApproval(await fixture.current());
  await fixture.put("terms.txt", "changed original terms");
  await assert.rejects(fixture.verify(approved), /terms or agreement bytes changed/);
  await fixture.put("terms.txt", terms);
  await fixture.put("agreement.txt", "");
  await assert.rejects(fixture.verify(approved), /invalid or oversized/);
  await fixture.put("agreement.txt", agreement);
  const original = await fs.readFile(fixture.journal, "utf8");
  await fixture.record({ ...fixture.response, threadId: "thread-b" });
  const complete = await fs.readFile(fixture.journal, "utf8");
  await fs.writeFile(fixture.journal, original);
  await assert.rejects(fixture.verify(approved), /checkpoint/);
  await fs.writeFile(fixture.journal, complete.replace("source-reviewer", "tampered-reviewer"));
  await assert.rejects(fixture.verify(approved), /integrity/);
  await fs.writeFile(fixture.journal, complete);
  await fixture.verify(approved);
  await assert.rejects(evidence.verifyCurrentProjectReview(approved, evidence.parseEvidence(approved).project,
    { ...fixture.options, journal: path.join(path.dirname(fixture.journal), "absent.jsonl") }), /No reviewed clarification/);
});

function runtime(file, mocks) {
  const filename = path.join(__dirname, "..", file);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(filename, "utf8"), {
    module, URL, Buffer, __dirname: path.dirname(filename), process: { env },
    require: key => Object.hasOwn(mocks, key) ? mocks[key] : localRequire(key)
  }, { filename });
  return module.exports;
}

test("direct generation and submission reject stale journal evidence without starting an external action", async t => {
  const fixture = await setup(t);
  const generation = generationApproval(projectApproval(await fixture.current()));
  const submission = submissionApproval(generation);
  const core = { ...evidence, verifyCurrentProjectReview: (row, review) =>
    evidence.verifyCurrentProjectReview(row, review, fixture.options) };
  const notes = [];
  const sheets = row => ({
    getApprovalProject: async () => row,
    updateProject: async (id, values) => { assert.deepEqual(Object.keys(values), ["Notes"]); notes.push(values.Notes); }
  });
  const common = {
    "./worker-lock": { withWorkerLock: fn => fn() }, "./approval-evidence": core,
    "./execution-permit": {
      openPermit: async () => ({ permit: { projectId, trackingId: base.id }, validate: async () => {}, claim: async () => {} }),
      approvalBinding: require("../execution-permit").approvalBinding
    }
  };
  const directGeneration = runtime("elevenlabs.js", { ...common, "./googleSheets": sheets(generation),
    "./s3": { uploadFile: () => assert.fail("AWS called") } });
  const directSubmission = (row, currentInputs = inputs) => runtime("voice123-submission.js", {
    ...common, "./googleSheets": sheets(row), "./elevenlabs": { generationInputs: () => currentInputs },
    "./approval-audio": { stageAudio: async () => ({ file: "/dummy.mp3", digest: async () => hash(audio), cleanup: async () => {} }) }
  }).submitApprovedAudio(row.url, "/dummy.mp3", { connect: () => assert.fail("Voice123 browser opened") });
  await assert.rejects(directSubmission(submission, { ...inputs, voice: "another-voice" }), /changed/);
  await fixture.record(fixture.response);
  await assert.rejects(directGeneration.generateAudio(generation.id, script), /fresh project review/);
  await assert.rejects(directSubmission(submission), /fresh project review/);
  await assert.rejects(directSubmission({ ...submission, status: "Submission Uncertain" }), /unresolved submission attempt/);
  await assert.rejects(directSubmission({ ...submission, status: "Approved", evidence: "" }), /requires explicit approval/);
  const legacy = { ...generation, evidence: JSON.stringify({ ...JSON.parse(generation.evidence), version: 1 }) };
  assert.throws(() => evidence.authorizeGeneration(legacy, script, inputs), /version/);
  assert.equal(notes.length, 0);
});
