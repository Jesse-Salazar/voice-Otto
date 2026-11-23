const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { extractAttachment, MAX_FILE_BYTES } = require("../attachment-review");
const { authorizeGeneration, transition, rights, sha256, verifyProjectAttachmentReview } = require("../approval-evidence");

let directory;
before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "voice-otto-attachment-fixtures-"));
  await promisify(execFile)(process.env.ATTACHMENT_PYTHON || "python3",
    ["-I", "-B", path.join(__dirname, "fixtures/create-attachments.py"), directory]);
});
after(async () => { if (directory) await fs.rm(directory, { recursive: true, force: true }); });
const read = filename => extractAttachment(path.join(directory, filename));
async function fixture(filename, text) {
  await fs.writeFile(path.join(directory, filename), text);
  return read(filename);
}

test("spreadsheets, DOCX and PDF retain coordinates, order and page boundaries", async () => {
  const [xlsx, xls, docx, pdf] = await Promise.all(["xlsx", "xls", "docx", "pdf"].map(type => read("dialogue." + type)));
  assert.deepEqual(xlsx.sections.map(section => section.name), ["Recording Script", "Instructions"]);
  assert.deepEqual(xlsx.sections[0].blocks.map(block => block.location), ["A1", "B2"]);
  assert.match(xlsx.warnings[0], /Formula/);
  assert.equal(xlsx.sections[1].blocks[0].lines[0].kind, "instruction");
  assert.deepEqual(xls.sections.map(section => section.name), ["Legacy dialogue", "Directions"]);
  assert.equal(xls.sections[0].blocks[0].location, "A1");
  assert.deepEqual(docx.sections[0].blocks.map(block => block.kind), ["paragraph", "table-cell", "paragraph"]);
  assert.match(docx.sections[0].blocks[2].text, /\f/);
  assert.deepEqual(pdf.sections.map(section => section.page), [1, 2]);
  for (const report of [xlsx, xls, docx, pdf]) {
    assert.ok(report.candidateLines > 0);
    assert.equal(report.status, "Needs Review");
    assert.match(report.provenance.sha256, /^[a-f0-9]{64}$/);
    assert.match(report.provenance.extractionSha256, /^[a-f0-9]{64}$/);
    assert.equal(report.script, undefined);
  }
});

test("recording candidates are separated from instructions, role descriptions, licensing and unrelated notes", async () => {
  const review = await fixture("review.txt", [
    "Instructions: Please record softly.", "Role description: The narrator is curious.",
    "Recording script", "Narrator: Welcome to the harbor.", "Narrator: The lighthouse is still shining.",
    "Licensing: Authorization for permanent synthetic voice use and sublicensing.", "Budget: Zero dollars"
  ].join("\n"));
  assert.deepEqual(review.sections[0].blocks.map(block => block.lines[0].kind),
    ["instruction", "role-description", "heading", "dialogue-candidate", "dialogue-candidate", "licensing", "unrelated"]);
  assert.equal(review.candidateLines, 2);
  assert.deepEqual(review.unresolvedRights, [
    "Permanent usage", "Voice-data sublicensing", "TTS or synthetic-voice authorization"
  ]);
  assert.equal(review.status, "Needs Review");
  const directions = await fixture("directions.txt", "Instructions: Please record according to the role description.\nUse a quiet room.");
  assert.equal(directions.candidateLines, 0);
  assert.ok(directions.reviewFlags.includes("no-clear-recording-dialogue"));
});

test("Chinese English-audition header scopes candidate recording text to cells below it in the same column", async () => {
  const report = await read("english-audition-header.xlsx");
  const blocks = report.sections[0].blocks;
  const candidates = blocks.filter(block => block.lines.some(line => line.kind === "dialogue-candidate"));
  assert.deepEqual(candidates.map(block => [block.location, block.text]), [
    ["E3", "Wait—did you hear that?"], ["E4", "There’s a light in the window."]
  ]);
  assert.equal(blocks.find(block => block.location === "E2").lines[0].kind, "heading");
  assert.equal(blocks.find(block => block.location === "E5").lines[0].kind, "instruction");
  assert.ok(report.reviewFlags.includes("possible-multilingual"));
  assert.equal(report.status, "Needs Review");
  assert.equal(report.script, undefined);
});

test("multiple candidate scripts, roles, and languages are explicitly flagged", async () => {
  const review = await fixture("variants.txt", [
    "Script A", "Narrator: Hello and welcome to the harbor.", "Pilot: Thank you for the ride.",
    "Script B", "Narrator: Hola y gracias.", "Pilot: 你好，你今天好吗？"
  ].join("\n"));
  assert.equal(review.candidateLines, 4);
  for (const flag of ["multiple-candidate-sections", "multiple-roles", "possible-multilingual"]) {
    assert.ok(review.reviewFlags.includes(flag));
  }
  const single = await fixture("single.txt", "Narrator: Good morning.");
  assert.ok(single.reviewFlags.includes("possibly-incomplete"));
  assert.equal(single.status, "Needs Review");
});

test("malformed, unsafe, unsupported, empty and oversized files fail closed", async () => {
  for (const filename of ["macro.xlsx", "external.xlsx", "entities.xlsx", "expansion.xlsx"]) {
    await assert.rejects(read(filename));
  }
  await assert.rejects(fixture("empty.txt", ""), /empty/);
  await assert.rejects(fixture("odd.txt", Buffer.from([0, 255])));
  await assert.rejects(fixture("damaged.xlsx", "no package"), /Malformed/);
  await assert.rejects(fixture("damaged.xls", "no compound document"), /compound/);
  await assert.rejects(fixture("damaged.pdf", "%PDF-1.4"), /Malformed/);
  await assert.rejects(fixture("legacy.doc", "not supported"), /Legacy DOC is unsupported/);
  const oversized = path.join(directory, "oversized.txt");
  await fs.writeFile(oversized, "");
  await fs.truncate(oversized, MAX_FILE_BYTES + 1);
  await assert.rejects(read("oversized.txt"), /exceeds 8 MiB/);
  const overExtract = await fixture("too-much.txt", "x".repeat(120001)).catch(error => error);
  assert.match(overExtract.message, /text or block limit/);
  await fs.symlink(path.join(directory, "dialogue.xlsx"), path.join(directory, "symlink.xlsx"));
  await assert.rejects(read("symlink.xlsx"));
});

test("changed attachment bytes, extraction evidence and chosen script invalidate approval", async () => {
  const voice123Id = "SYNTHATTACHMENT";
  const projectDirectory = path.join(directory, voice123Id);
  await fs.mkdir(projectDirectory);
  const source = path.join(projectDirectory, "same.txt");
  const text = "Narrator: The lighthouse is still shining.";
  await fs.writeFile(source, text + "\n");
  const original = await extractAttachment(source);
  const base = { id: "synthetic", url: `https://voice123.com/projects/${voice123Id}/fixture/specs`, status: "Needs Review" };
  const input = {
    reviewer: "fixture-reviewer", expiresAt: new Date(Date.now() + 3600000).toISOString(), script: text,
    attachmentReview: { outcome: "reviewed", reason: "Verified line 1", sources: [original.provenance] },
    clarification: {
      version: 1, projectId: voice123Id, snapshotHash: sha256("snapshot"), script: { version: "1", sha256: sha256(text) },
      terms: { filename: "terms.txt", version: "1", sha256: sha256("terms") },
      agreement: null, agreementRequired: false,
      attachments: [{ filename: original.provenance.filename, version: "1", sha256: original.provenance.sha256 }]
    },
    revisionReview: { outcome: "new invitation", reason: "Fixture" },
    rights: Object.fromEntries(rights.map(flag => [flag, { outcome: "cleared", reason: "Synthetic fixture only" }]))
  };
  const generationInputs = { voice: "dummy", model: "dummy", settings: { speed: 1 } };
  const review = transition(base, "project", input);
  const reviewed = { ...base, script: review.Script, status: review.Status, evidence: review["Approval Evidence"] };
  const generation = transition(reviewed, "generation", { ...input, inputs: generationInputs });
  const approved = { ...reviewed, status: generation.Status, evidence: generation["Approval Evidence"] };
  assert.ok(authorizeGeneration(approved, text, generationInputs));
  await verifyProjectAttachmentReview(approved, input.attachmentReview, directory);

  await fs.writeFile(source, text + "\n\n");
  const changed = await extractAttachment(source);
  assert.equal(changed.provenance.filename, original.provenance.filename);
  assert.equal(changed.provenance.extractionSha256, original.provenance.extractionSha256);
  assert.notEqual(changed.provenance.sha256, original.provenance.sha256);
  await assert.rejects(verifyProjectAttachmentReview(approved, input.attachmentReview, directory), /changed/);
  assert.throws(() => authorizeGeneration({ ...approved, script: text + " Changed." }, text + " Changed.", generationInputs));
  const modified = JSON.parse(approved.evidence);
  modified.project.attachmentReview.sources[0].extractionSha256 = "0".repeat(64);
  assert.throws(() => authorizeGeneration({ ...approved, evidence: JSON.stringify(modified) }, text, generationInputs), /changed/);
  assert.throws(() => transition(base, "project", { ...input, attachmentReview: { outcome: "reviewed", reason: "No source" } }));
});
