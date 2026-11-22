const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { projectIdentity } = require("./voice123-projects");
const { validSources, verifyAttachmentSources, MAX_FILE_BYTES } = require("./attachment-review");
const { currentProjectMaterial, validateMaterialBinding } = require("./clarification-log");
const { validateLocalPaths } = require("./connectivity-local");

const rights = ["Permanent usage", "Voice-data sublicensing", "TTS or synthetic-voice authorization"];
const stages = ["project", "generation", "submission"];
const sha256 = value => createHash("sha256").update(value).digest("hex");
const digestPattern = /^[a-f0-9]{64}$/;
const canonical = value => JSON.stringify(value, (key, field) =>
  field && typeof field === "object" && !Array.isArray(field)
    ? Object.fromEntries(Object.entries(field).sort(([a], [b]) => a.localeCompare(b)))
    : field);
const fingerprint = value => sha256(canonical(value));
const nonempty = value => typeof value === "string" && Boolean(value.trim());

class ApprovalError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "ApprovalError";
  }
}

function requireEvidence(condition, reason) {
  if (!condition) throw new ApprovalError(reason);
}

function identity(row) {
  const project = projectIdentity(row?.url);
  requireEvidence(nonempty(row?.id) && project, "Missing or invalid project identity");
  return { trackingId: row.id, voice123Id: project.id };
}

function parseEvidence(row, allowEmpty = false) {
  if (allowEmpty && !row.evidence) return { version: 2, ...identity(row) };
  let evidence;
  try {
    evidence = JSON.parse(row.evidence);
  } catch {
    throw new ApprovalError("Missing or malformed approval evidence");
  }
  const ids = identity(row);
  requireEvidence(evidence?.trackingId === ids.trackingId && evidence.voice123Id === ids.voice123Id,
    "Approval evidence project identity does not match");
  if (allowEmpty && evidence.version === 1) return { version: 2, ...ids };
  requireEvidence(evidence.version === 2, "Approval evidence version needs a fresh project review");
  return evidence;
}

function decision(evidence, stage, now) {
  const entry = evidence[stage];
  const time = Date.parse(entry?.at);
  const expiry = Date.parse(entry?.expiresAt);
  requireEvidence(entry?.decision === "approved" && nonempty(entry.reviewer) &&
    nonempty(entry.at) && nonempty(entry.expiresAt) && time <= now && expiry > now && expiry > time,
  `Missing, revoked, or expired ${stage} approval`);
  return entry;
}

function specification(value) {
  requireEvidence(nonempty(value?.voice) && nonempty(value?.model) && value.settings &&
    Object.keys(value.settings).length > 0 &&
    Object.values(value.settings).every(setting => typeof setting === "boolean" || Number.isFinite(setting)),
  "Invalid or incomplete generation settings");
  return value;
}

function assertProject(row, evidence, now) {
  const review = decision(evidence, "project", now);
  const attachments = review.attachmentReview;
  const reviewedSources = attachments?.outcome === "reviewed" && validSources(attachments.sources);
  const noSources = attachments?.outcome === "none" && (attachments.sources === undefined ||
    (Array.isArray(attachments.sources) && !attachments.sources.length));
  requireEvidence(nonempty(row.script) && row.script !== "MANUAL_REVIEW_REQUIRED" &&
    review.scriptSha256 === sha256(row.script) &&
    (reviewedSources || noSources) && nonempty(attachments.reason) &&
    ["resolved", "new invitation"].includes(review.revisionReview?.outcome) && nonempty(review.revisionReview.reason) &&
    rights.every(flag =>
      review.rights?.[flag]?.outcome === "cleared" && nonempty(review.rights[flag].reason)),
  "Recording script or required project review evidence does not match");
  assertMaterialBinding(row, review);
  return review;
}

function assertMaterialBinding(row, review) {
  let material;
  try {
    material = validateMaterialBinding(review?.clarification);
  } catch {
    throw new ApprovalError("Missing or malformed clarification evidence");
  }
  const sources = review.attachmentReview?.sources || [];
  requireEvidence(material.projectId === identity(row).voice123Id &&
    typeof row.script === "string" && material.script.sha256 === sha256(row.script),
  "Clarification evidence uses a different project or script");
  requireEvidence(material.attachments.length === sources.length && material.attachments.every(file =>
    sources.some(source => file.filename === source.filename && file.sha256 === source.sha256)),
  "Clarification attachment manifest differs from the reviewed sources");
  return material;
}

async function hashSource(filename) {
  const handle = await fs.open(filename, constants.O_NONBLOCK | constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size || stat.size > MAX_FILE_BYTES) throw new Error("Clarification source file is invalid or oversized");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > MAX_FILE_BYTES) throw new Error("Clarification source file exceeds its size limit");
      hash.update(buffer.subarray(0, bytesRead));
    }
    const end = await handle.stat();
    if (total !== stat.size || end.size !== stat.size || end.mtimeMs !== stat.mtimeMs || end.ctimeMs !== stat.ctimeMs) {
      throw new Error("Clarification source file changed while being read");
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function readCurrentClarification(row, { journal, sources } = {}) {
  try {
    if (journal === undefined && sources === undefined) {
      const paths = await validateLocalPaths(process.env);
      journal = paths.VOICE_OTTO_CLARIFICATION_LOG;
      sources = paths.VOICE_OTTO_CLARIFICATION_SOURCE_DIR;
    }
    const { voice123Id } = identity(row);
    const current = await currentProjectMaterial(journal, voice123Id);
    if (!path.isAbsolute(sources || "")) throw new Error("An absolute clarification source directory is required");
    const parent = await fs.realpath(sources);
    const projectDirectory = path.join(parent, voice123Id);
    if (await fs.realpath(projectDirectory) !== projectDirectory) throw new Error("Project clarification source directory may not be a symlink");
    for (const document of [current.terms, current.agreement].filter(Boolean)) {
      if (await hashSource(path.join(projectDirectory, document.filename)) !== document.sha256) {
        throw new Error("Project terms or agreement bytes changed; review the new sources");
      }
    }
    const latest = await currentProjectMaterial(journal, voice123Id);
    if (latest.snapshotHash !== current.snapshotHash) throw new Error("Clarification journal changed during verification");
    return current;
  } catch (error) {
    throw new ApprovalError(`Clarification evidence could not be verified: ${error.code || error.message}`);
  }
}

async function verifyCurrentProjectReview(row, review, options = {}) {
  const bound = assertMaterialBinding(row, review);
  let attachmentDirectory = options.attachmentDirectory;
  if (options.journal === undefined && options.sources === undefined) {
    try {
      attachmentDirectory = (await validateLocalPaths(process.env)).VOICE_OTTO_ATTACHMENT_DIR;
    } catch (error) {
      throw new ApprovalError(`Clarification evidence could not be verified: ${error.code || error.message}`);
    }
  }
  const recheckedAttachments = await verifyProjectAttachmentReview(
    row, review.attachmentReview, attachmentDirectory, bound, options.historyFile
  );
  const current = await readCurrentClarification(row, options);
  requireEvidence(fingerprint(bound) === fingerprint(current), "Clarification material changed; a fresh project review is required");
  return recheckedAttachments;
}

async function verifyProjectAttachmentReview(row, review, root, clarification,
  historyFile = path.join(__dirname, "processed-projects.json")) {
  try {
    const { voice123Id } = identity(row);
    const history = await fs.readFile(historyFile, "utf8")
      .then(JSON.parse).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    const records = history.filter(record => projectIdentity(record?.url)?.id === voice123Id);
    const known = records.flatMap(record => record.attachments || []);
    if (clarification && records.some(record => record.rightsFlags?.length) && !clarification.agreement) {
      throw new Error("Known voice-rights flags require the actual agreement source");
    }
    if (known.length && (review?.outcome !== "reviewed" || !validSources(review.sources) ||
      review.sources.length < known.length || known.some(attachment => attachment.types?.length &&
        !review.sources.some(source => attachment.types.includes(source.type))))) {
      throw new Error("Known project attachments require matching reviewed local sources");
    }
    await verifyAttachmentSources(voice123Id, review, root);
    return review?.outcome === "reviewed";
  } catch (error) {
    throw new ApprovalError(`Attachment evidence could not be verified: ${error.message}`);
  }
}

function assertGeneration(row, evidence, now, inputs) {
  const review = assertProject(row, evidence, now);
  const approval = decision(evidence, "generation", now);
  specification(approval.inputs);
  requireEvidence(approval.reviewHash === fingerprint(review) && Date.parse(approval.at) >= Date.parse(review.at) &&
    (!inputs || fingerprint(approval.inputs) === fingerprint(specification(inputs))),
  "Reviewed script, rights decision, voice, model, or generation settings changed");
  return approval;
}

function authorizeGeneration(row, text, inputs, now = Date.now()) {
  requireEvidence(row?.status === "Generation Approved" && row.script === text,
    "Generation requires an approved project and the exact reviewed recording script");
  return assertGeneration(row, parseEvidence(row), now, inputs);
}

function authorizeSubmission(row, audioSha256, { attemptId, inputs, now = Date.now() } = {}) {
  requireEvidence(row?.status === (attemptId ? "Submission Uncertain" : "Submission Approved"),
    "Submission requires explicit approval and no unresolved submission attempt");
  const evidence = parseEvidence(row);
  const generation = assertGeneration(row, evidence, now, inputs);
  let settings;
  try { settings = JSON.parse(row.voiceSettings); } catch {}
  const approval = decision(evidence, "submission", now);
  requireEvidence(nonempty(row.audioUrl) && approval.audioUrl === row.audioUrl &&
    digestPattern.test(audioSha256) && audioSha256 === approval.audioSha256 &&
    settings && fingerprint(settings) === fingerprint(generation.inputs.settings) &&
    approval.generationHash === fingerprint(generation) && Date.parse(approval.at) >= Date.parse(generation.at) &&
    (attemptId ? row.notes === attemptNote(attemptId) : !row.notes?.startsWith("Submission attempt ")),
  "Approved audio bytes, file reference, generation settings, or submission attempt do not match");
  return { evidence, approval };
}

function attemptNote(id) {
  return `Submission attempt ${id} reserved. Verify its outcome manually before retrying.`;
}

function transition(row, stage, input, now = Date.now()) {
  requireEvidence(stages.includes(stage) && nonempty(input.reviewer), "Invalid approval decision or reviewer");
  const unresolved = ["Processing", "Submission Uncertain"].includes(row?.status);
  requireEvidence(row?.status !== "Uploaded" && (!unresolved || input.revoke),
    "A running or unresolved external action requires manual reconciliation");
  const evidence = parseEvidence(row, stage === "project");
  const at = new Date(now).toISOString();
  const entry = { reviewer: input.reviewer, at, decision: input.revoke ? "revoked" : "approved" };
  if (!input.revoke) {
    requireEvidence(typeof input.expiresAt === "string" && Date.parse(input.expiresAt) > now,
      "Approval needs a future expiration timestamp");
    entry.expiresAt = new Date(input.expiresAt).toISOString();
  }
  let status;
  const changes = {};
  if (input.revoke) {
    requireEvidence(evidence[stage]?.decision === "approved", "No active decision to revoke");
    evidence[stage] = entry;
    status = { project: "Needs Review", generation: "Project Reviewed", submission: "Pending Submission Approval" }[stage];
  } else if (stage === "project") {
    requireEvidence(nonempty(input.script), "An exact recording script is required");
    evidence.project = {
      ...entry, scriptSha256: sha256(input.script), attachmentReview: input.attachmentReview,
      revisionReview: input.revisionReview, rights: input.rights, clarification: input.clarification
    };
    assertProject({ ...row, script: input.script }, evidence, now);
    changes.Script = input.script;
    status = "Project Reviewed";
  } else if (stage === "generation") {
    requireEvidence(row.status === "Project Reviewed", "Generation approval requires a completed project review");
    const review = assertProject(row, evidence, now);
    evidence.generation = { ...entry, reviewHash: fingerprint(review), inputs: specification(input.inputs) };
    status = "Generation Approved";
  } else {
    requireEvidence(row.status === "Pending Submission Approval", "Submission approval requires completed generation");
    const generation = assertGeneration(row, evidence, now);
    evidence.submission = {
      ...entry, generationHash: fingerprint(generation), audioUrl: row.audioUrl, audioSha256: input.audioSha256
    };
    status = "Submission Approved";
    authorizeSubmission({ ...row, status, evidence: JSON.stringify(evidence) }, input.audioSha256, { now, inputs: input.inputs });
  }
  for (const downstream of stages.slice(stages.indexOf(stage) + 1)) delete evidence[downstream];
  if (unresolved) status = row.status;
  if (stage !== "submission" && !unresolved) {
    changes["Audio File URL"] = "";
    changes["Voice Settings"] = "";
  }
  return { ...changes, Status: status, "Reviewed At": at, "Approval Evidence": JSON.stringify(evidence) };
}

function authorizeProjectReview(row, now = Date.now()) {
  return assertProject(row, parseEvidence(row), now);
}

module.exports = { ApprovalError, rights, sha256, fingerprint, parseEvidence, authorizeProjectReview, authorizeGeneration, authorizeSubmission,
  transition, attemptNote, verifyProjectAttachmentReview, readCurrentClarification, verifyCurrentProjectReview };
