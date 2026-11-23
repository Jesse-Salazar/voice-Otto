const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { appendClarification, readClarifications, classifyApprovalInvalidation } = require("../clarification-log");

const hash = value => createHash("sha256").update(value).digest("hex");
const registry = [
  { id: "SYNTH01", title: "Synthetic audition one", threads: [{ source: "fixture", id: "thread-one" }] },
  { id: "SYNTH02", title: "Synthetic audition two", threads: [{ source: "fixture", id: "thread-two" }] }
];
const message = {
  kind: "message", source: "fixture", threadId: "thread-one", messageId: "message-one",
  timestamp: "2026-02-03T04:05:06-05:00", direction: "inbound",
  sender: { id: "client-one", displayName: "Fixture client", verification: "verified" },
  recipient: { id: "reviewer", displayName: "Fixture reviewer", verification: "verified" },
  text: "  Please read only line one.\r\nAgreement terms are attached.  ",
  attachments: [{ filename: "script.xlsx", version: "1", sha256: hash("script one") }],
  agreement: { version: "1", sha256: hash("agreement one") },
  unresolvedQuestions: ["Clarify permitted downstream use"]
};

async function journal(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "voice-otto-clarification-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, "fixture.jsonl");
}

test("association uses a verified source and thread or observed project ID, with conflicts blocked", async t => {
  const file = await journal(t);
  const recorded = await appendClarification(file, { ...message, reviewStatus: "Approved" }, registry);
  assert.equal(recorded.record.event.projectId, "SYNTH01");
  assert.equal(recorded.record.event.projectTitle, "Synthetic audition one");
  assert.equal(recorded.record.event.reviewStatus, "Needs Review");
  assert.equal(recorded.record.event.text, message.text);
  assert.equal(recorded.record.event.timestamp, "2026-02-03T09:05:06.000Z");
  const explicit = await appendClarification(file, { ...message, observedProjectId: "SYNTH02", threadId: null }, registry);
  assert.equal(explicit.record.event.projectId, "SYNTH02");
  await assert.rejects(appendClarification(file, { ...message, observedProjectId: "SYNTH02" }, registry), /conflicting project association/);
  await assert.rejects(appendClarification(file, { ...message, projectId: "SYNTH01", threadId: null }, registry), /Missing or conflicting/);
  const ambiguous = [...registry, { id: "SYNTH03", title: "other", threads: registry[0].threads }];
  await assert.rejects(appendClarification(file, message, ambiguous), /Ambiguous thread binding/);
  assert.equal((await readClarifications(file)).length, 2);
});

test("duplicate messages leave the original bytes intact and conflicting IDs fail closed", async t => {
  const file = await journal(t);
  const first = await appendClarification(file, message, registry);
  const original = await fs.readFile(file, "utf8");
  const copy = await appendClarification(file, message, registry);
  assert.equal(copy.appended, false);
  assert.equal(copy.record.hash, first.record.hash);
  assert.equal(await fs.readFile(file, "utf8"), original);
  await assert.rejects(appendClarification(file, { ...message, text: "Different text under the same ID" }, registry), /Conflicting evidence/);

  assert.equal((await appendClarification(file, { ...message, messageId: null }, registry)).appended, false);
  const unnumbered = { ...message, text: "Another fixture message", messageId: null };
  assert.equal((await appendClarification(file, unnumbered, registry)).appended, true);
  assert.equal((await appendClarification(file, unnumbered, registry)).appended, false);
  const [firstRecord, secondRecord] = await readClarifications(file);
  assert.equal(secondRecord.previousHash, firstRecord.hash);
  assert.ok((await fs.readFile(file, "utf8")).startsWith(original));
});

test("missing or ambiguous sender stays unverified and does not create approval", async t => {
  const file = await journal(t);
  for (const [index, sender] of [undefined, { displayName: "Shared name", verification: "ambiguous" }].entries()) {
    const { record } = await appendClarification(file, { ...message, messageId: "identity-" + index, sender }, registry);
    assert.equal(record.event.reviewStatus, "Identity Unverified");
    assert.ok(record.event.unresolvedQuestions.includes("Verify sender identity"));
    assert.equal(record.event.approval, undefined);
  }
  await assert.rejects(appendClarification(file, {
    ...message, sender: { displayName: "Display name only", verification: "verified" }
  }, registry), /stable identity/);
});

test("new attachments and agreements are recorded alongside originals and invalidate dependent approvals", async t => {
  const file = await journal(t);
  await appendClarification(file, message, registry);
  const replacement = {
    ...message, messageId: "message-two",
    attachments: [{ ...message.attachments[0], sha256: hash("changed bytes under the same filename") }],
    agreement: { ...message.agreement, sha256: hash("changed agreement with same version label") }
  };
  await appendClarification(file, replacement, registry);
  const [original, updated] = (await readClarifications(file)).map(record => record.event);
  assert.deepEqual(original.attachments, message.attachments);
  assert.deepEqual(original.agreement, message.agreement);
  assert.equal(updated.reviewStatus, "Needs Review");
  const baseline = {
    scriptSha256: hash("script"), attachments: original.attachments, termsSha256: hash("terms"),
    agreement: original.agreement, generationSettingsSha256: hash("settings"), audioSha256: hash("audio")
  };
  for (const [key, value, label] of [
    ["attachments", updated.attachments, "attachments"], ["agreement", updated.agreement, "agreement"],
    ["scriptSha256", hash("new script"), "script"], ["termsSha256", hash("new terms"), "terms"]
  ]) {
    assert.deepEqual(classifyApprovalInvalidation(baseline, { ...baseline, [key]: value }), {
      changed: [label], stale: { projectReview: true, generation: true, submission: true }
    });
  }
  assert.deepEqual(classifyApprovalInvalidation(baseline, { ...baseline, generationSettingsSha256: hash("new settings") }).stale,
    { projectReview: false, generation: true, submission: true });
  assert.deepEqual(classifyApprovalInvalidation(baseline, { ...baseline, audioSha256: hash("new audio") }).stale,
    { projectReview: false, generation: false, submission: true });
  const pending = { ...baseline, generationSettingsSha256: null, audioSha256: null };
  assert.deepEqual(classifyApprovalInvalidation(pending, { ...pending, scriptSha256: hash("new audition") }).stale,
    { projectReview: true, generation: true, submission: true });
  assert.throws(() => classifyApprovalInvalidation(baseline, { ...baseline, termsSha256: "" }), /comparison hash/);
});

test("an ambiguous or interrupted send cannot be retried through the journal", async t => {
  const file = await journal(t);
  const attempt = {
    kind: "send-outcome", source: "fixture", threadId: "thread-one", timestamp: "2026-02-03T04:05:06Z",
    operationId: "operation-one", messageSha256: hash("exact outgoing clarification"), outcome: "attempted",
    reviewer: "fixture-reviewer", verifiedSource: "local send approval fixture"
  };
  await assert.rejects(appendClarification(file, { ...attempt, outcome: "uncertain" }, registry), /prior recorded attempt/);
  await appendClarification(file, attempt, registry);
  await assert.rejects(appendClarification(file, attempt, registry), /cannot be retried/);
  await appendClarification(file, { ...attempt, outcome: "uncertain" }, registry);
  await assert.rejects(appendClarification(file, attempt, registry), /cannot be retried/);
  await assert.rejects(appendClarification(file, { ...attempt, operationId: "new-id" }, registry), /reconcile it/);
  await assert.rejects(appendClarification(file, {
    ...attempt, outcome: "reconciled-not-sent", reviewer: null
  }, registry), /requires a human/);
  await appendClarification(file, { ...attempt, outcome: "reconciled-not-sent", reviewer: "fixture-reviewer",
    verifiedSource: "provider audit fixture" }, registry);
  await assert.rejects(appendClarification(file, attempt, registry), /cannot be retried/);
  assert.deepEqual((await readClarifications(file)).map(record => record.event.outcome),
    ["attempted", "uncertain", "reconciled-not-sent"]);
});

test("an interrupted local append fails closed without rewriting the prior history", async t => {
  const file = await journal(t);
  await appendClarification(file, message, registry);
  await fs.appendFile(file, '{"truncated":');
  const before = await fs.readFile(file, "utf8");
  await assert.rejects(appendClarification(file, { ...message, messageId: "next" }, registry), /incomplete record/);
  assert.equal(await fs.readFile(file, "utf8"), before);
});
