// Append-only local clarification evidence. The journal never sends messages.
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const MAX_LOG = 8 * 1024 * 1024;
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha256 = /^[a-f0-9]{64}$/;
const text = (value, limit) => typeof value === "string" && Boolean(value.trim()) && value.length <= limit;

function requireValid(condition, message) {
  if (!condition) throw new Error(message);
}

function optionalId(value, label) {
  requireValid(value == null || (text(value, 180) && !/[\r\n\u0000]/u.test(value)), `Invalid ${label}`);
  return value ?? null;
}

function associate(input, registry) {
  requireValid(text(input.source, 120), "A clarification source is required");
  const threadId = optionalId(input.threadId, "thread ID");
  const matches = threadId == null ? [] : registry.filter(project =>
    project.threads?.some(thread => thread.source === input.source && thread.id === threadId));
  requireValid(matches.length <= 1, "Ambiguous thread binding");
  const observed = optionalId(input.observedProjectId, "observed project ID");
  const explicit = observed && registry.filter(project => project.id === observed);
  requireValid(!observed || explicit.length === 1, "Unknown or ambiguous observed project ID");
  const project = matches[0] || explicit?.[0];
  requireValid(project && (!observed || project.id === observed) &&
    (!input.projectId || project.id === input.projectId), "Missing or conflicting project association");
  requireValid(text(project.id, 80) && text(project.title, 240), "Invalid associated project");
  return { projectId: project.id, projectTitle: project.title, source: input.source, threadId };
}

function party(value) {
  const identity = value?.verification ?? "missing";
  requireValid(["verified", "unverified", "ambiguous", "missing"].includes(identity), "Invalid participant verification");
  const id = optionalId(value?.id, "participant ID");
  requireValid(identity !== "verified" || id, "Verified participant needs a stable identity");
  const displayName = optionalId(value?.displayName, "participant name");
  return { id, displayName, verification: identity };
}

function documentVersion(value) {
  requireValid(text(value?.version, 120) && typeof value.sha256 === "string" && sha256.test(value.sha256),
    "Document version and SHA-256 are required");
  return { version: value.version, sha256: value.sha256 };
}

function sourceDocument(value) {
  return attachments([value])[0];
}

function attachments(values = []) {
  requireValid(Array.isArray(values) && values.length <= 16, "Invalid attachment list");
  const files = values.map(file => {
    requireValid(text(file?.filename, 255) && path.basename(file.filename) === file.filename &&
      !/[\\\u0000-\u001f]/u.test(file.filename) && ![".", ".."].includes(file.filename), "Invalid attachment filename");
    return { filename: file.filename, ...documentVersion(file) };
  });
  requireValid(new Set(files.map(file => file.filename.normalize("NFC").toLowerCase())).size === files.length,
    "Conflicting attachment filenames");
  return files;
}

function timestamp(value) {
  requireValid(typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/u.test(value) &&
    Number.isFinite(Date.parse(value)), "Timestamp must include a date, time and timezone");
  return new Date(value).toISOString();
}

function normalize(input, registry) {
  const context = associate(input, registry);
  const at = timestamp(input.timestamp);
  if (input.kind === "identity-resolution") {
    const reviewer = optionalId(input.reviewer, "reviewer");
    const verifiedSource = optionalId(input.verifiedSource, "identity verification source");
    const sender = party(input.sender);
    const recipient = party(input.recipient);
    requireValid(reviewer && verifiedSource && typeof input.messageHash === "string" && sha256.test(input.messageHash) &&
      sender.verification === "verified" && recipient.verification === "verified", "Identity resolution requires verified participants and human evidence");
    return { kind: input.kind, ...context, timestamp: at, messageHash: input.messageHash, reviewer, verifiedSource, sender, recipient };
  }
  if (input.kind === "project-material") {
    const reviewer = optionalId(input.reviewer, "material reviewer");
    const verifiedSource = optionalId(input.verifiedSource, "material verification source");
    const reviewedThrough = input.reviewedThrough;
    requireValid(reviewer && verifiedSource && (reviewedThrough === null ||
      (typeof reviewedThrough === "string" && sha256.test(reviewedThrough))), "Project material requires a human review of the journal position");
    return { kind: input.kind, ...context, timestamp: at, reviewer, verifiedSource, reviewedThrough,
      ...normalizeMaterial(input) };
  }
  if (input.kind === "send-outcome") {
    const operationId = optionalId(input.operationId, "operation ID");
    requireValid(operationId && ["attempted", "uncertain", "confirmed-sent", "reconciled-not-sent"].includes(input.outcome) &&
      typeof input.messageSha256 === "string" && sha256.test(input.messageSha256), "Invalid send-outcome evidence");
    const reviewer = optionalId(input.reviewer, "reviewer");
    const verifiedSource = optionalId(input.verifiedSource, "reconciliation source");
    if (input.outcome === "attempted") {
      requireValid(reviewer && verifiedSource, "A send attempt requires a human and an explicit authorization reference");
    } else if (["confirmed-sent", "reconciled-not-sent"].includes(input.outcome)) {
      requireValid(reviewer && verifiedSource, "Reconciliation requires a human and a verification source");
    }
    return { kind: input.kind, ...context, timestamp: at, operationId, outcome: input.outcome,
      messageSha256: input.messageSha256, reviewer, verifiedSource };
  }

  requireValid(input.kind === "message" && ["inbound", "outbound"].includes(input.direction), "Invalid message direction");
  const sender = party(input.sender);
  const recipient = party(input.recipient);
  const documents = attachments(input.attachments);
  requireValid(typeof input.text === "string" && input.text.length <= 32_000 && (input.text.trim() || documents.length),
    "Exact message text or attachment metadata is required");
  const questions = input.unresolvedQuestions ?? [];
  requireValid(Array.isArray(questions) && questions.length <= 30 && questions.every(question => text(question, 500)),
    "Invalid unresolved questions");
  const unresolvedQuestions = [...questions];
  if (sender.verification !== "verified") unresolvedQuestions.push("Verify sender identity");
  if (recipient.verification !== "verified") unresolvedQuestions.push("Verify recipient identity");
  return {
    kind: input.kind, ...context, timestamp: at, direction: input.direction,
    messageId: optionalId(input.messageId, "message ID"), sender, recipient, text: input.text,
    attachments: documents, agreement: input.agreement == null ? null : documentVersion(input.agreement),
    reviewStatus: sender.verification === "verified" && recipient.verification === "verified" ? "Needs Review" : "Identity Unverified",
    unresolvedQuestions: [...new Set(unresolvedQuestions)]
  };
}

function normalizeMaterial(input) {
  requireValid(typeof input.agreementRequired === "boolean" && (input.agreement === null || input.agreement) &&
    (!input.agreementRequired || input.agreement), "Explicit agreement applicability and required agreement evidence are missing");
  requireValid(Array.isArray(input.attachments), "An explicit attachment manifest is required");
  const terms = sourceDocument(input.terms);
  const agreement = input.agreement === null ? null : sourceDocument(input.agreement);
  requireValid(!agreement || terms.filename.normalize("NFC").toLowerCase() !== agreement.filename.normalize("NFC").toLowerCase(),
    "Project terms and agreement must be separate source files");
  return { script: documentVersion(input.script), terms, agreement, agreementRequired: input.agreementRequired,
    attachments: attachments(input.attachments).sort((a, b) => a.filename.localeCompare(b.filename)) };
}

function validateIdentityResolution(event, records) {
  const source = records.find(record => record.hash === event.messageHash)?.event;
  requireValid(source?.kind === "message" && source.direction === "inbound" &&
    source.reviewStatus === "Identity Unverified" && source.projectId === event.projectId &&
    source.source === event.source && source.threadId === event.threadId && event.timestamp >= source.timestamp &&
    (!source.sender.id || source.sender.id === event.sender.id) &&
    (!source.recipient.id || source.recipient.id === event.recipient.id) &&
    !records.some(({ event: prior }) => prior.kind === "identity-resolution" && prior.messageHash === event.messageHash),
  "Missing, conflicting, or cross-project message identity resolution");
}

function isIncomingEvidence(event) {
  return (event.kind === "message" && event.direction === "inbound") || event.kind === "identity-resolution";
}

function validateProjectMaterial(event, records) {
  normalizeMaterial(event);
  const related = records.filter(record => record.event.projectId === event.projectId);
  const incoming = related.filter(record => isIncomingEvidence(record.event));
  const identities = new Set(incoming.filter(record => record.event.kind === "identity-resolution").map(record => record.event.messageHash));
  requireValid(incoming.every(record => record.event.reviewStatus !== "Identity Unverified" || identities.has(record.hash)),
    "Unresolved sender or recipient identity blocks project review");
  requireValid(event.reviewedThrough === (incoming.at(-1)?.hash ?? null) &&
    (!incoming.length || event.timestamp >= incoming.at(-1).event.timestamp), "Project material has unreviewed clarifications");
  const previous = related.findLast(record => record.event.kind === "project-material");
  const newMessages = incoming.filter(record => record.sequence > (previous?.sequence ?? 0) && record.event.kind === "message");
  const latestFiles = new Map();
  let latestAgreement;
  for (const { event: reply } of newMessages) {
    for (const file of reply.attachments) latestFiles.set(file.filename, file);
    if (reply.agreement) latestAgreement = reply.agreement;
  }
  const sameVersion = (a, b) => a && a.version === b.version && a.sha256 === b.sha256;
  requireValid([...latestFiles.values()].every(file => sameVersion(event.attachments.find(source => source.filename === file.filename), file)) &&
    (!latestAgreement || sameVersion(event.agreement, latestAgreement)),
  "Project material omits or conflicts with attachment or agreement revisions in a clarification");
}

function duplicateKey(event) {
  if (event.kind !== "message") return null;
  if (event.messageId) return digest([event.source, event.threadId || event.projectId, event.messageId]);
  return digest([event.source, event.projectId, event.threadId, event.direction, event.timestamp,
    event.sender.id, event.recipient.id, event.text, event.attachments, event.agreement]);
}

function messageFingerprint(event) {
  return digest([event.projectId, event.direction, event.timestamp, event.sender.id, event.recipient.id,
    event.text, event.attachments, event.agreement]);
}

function validateSendOutcome(event, records) {
  const history = records.filter(record => record.event.kind === "send-outcome" && record.event.operationId === event.operationId);
  const previous = history.at(-1)?.event;
  if (!previous) {
    requireValid(event.outcome === "attempted", "Send outcome requires a prior recorded attempt");
    const otherAttempts = new Map();
    for (const { event: prior } of records) {
      if (prior.kind === "send-outcome" && prior.projectId === event.projectId && prior.source === event.source &&
          prior.threadId === event.threadId && prior.messageSha256 === event.messageSha256) {
        otherAttempts.set(prior.operationId, prior.outcome);
      }
    }
    requireValid([...otherAttempts.values()].every(outcome => outcome === "reconciled-not-sent"),
      "A matching message was attempted or sent; reconcile it before recording another attempt");
    return;
  }
  requireValid(previous.projectId === event.projectId && previous.source === event.source &&
    previous.threadId === event.threadId && previous.messageSha256 === event.messageSha256 &&
    event.timestamp >= previous.timestamp, "Conflicting send-outcome evidence");
  requireValid((previous.outcome === "attempted" && ["uncertain", "confirmed-sent", "reconciled-not-sent"].includes(event.outcome)) ||
    (previous.outcome === "uncertain" && ["confirmed-sent", "reconciled-not-sent"].includes(event.outcome)),
  "An existing or uncertain send attempt cannot be retried");
}

async function readClarifications(filename) {
  const headFile = filename + ".head";
  const headStat = await fs.lstat(headFile).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  let head = null;
  if (headStat) {
    requireValid(headStat.isFile() && headStat.size <= 512, "Invalid clarification journal checkpoint");
    const raw = await fs.readFile(headFile, { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW });
    try {
      head = JSON.parse(raw);
    } catch {
      throw new Error("Malformed clarification journal checkpoint");
    }
    requireValid(Number.isSafeInteger(head?.sequence) && head.sequence > 0 && typeof head.hash === "string" && sha256.test(head.hash),
      "Invalid clarification journal checkpoint");
  }
  const stat = await fs.lstat(filename).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) {
    requireValid(!head, "Clarification journal checkpoint has no matching journal");
    return [];
  }
  requireValid(stat.isFile() && stat.size <= MAX_LOG, "Clarification log is not a regular file or exceeds its limit");
  const contents = await fs.readFile(filename, { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW });
  if (!contents) {
    requireValid(!head, "Clarification journal checkpoint has no matching records");
    return [];
  }
  requireValid(contents.endsWith("\n"), "Clarification log has an incomplete record; reconcile locally");
  const records = [];
  let previousHash = null;
  for (const line of contents.slice(0, -1).split("\n")) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error("Malformed clarification journal record");
    }
    requireValid(record?.version === 1 && record.sequence === records.length + 1 && record.previousHash === previousHash &&
      record.hash === digest([record.version, record.sequence, record.previousHash, record.event]),
    "Clarification log integrity check failed");
    records.push(record);
    previousHash = record.hash;
  }
  requireValid(head?.sequence === records.length && head.hash === previousHash,
    "Clarification journal checkpoint is missing or inconsistent; reconcile locally");
  return records;
}

async function appendClarification(filename, input, registry) {
  const event = normalize(input, registry);
  const lockPath = filename + ".lock";
  const lock = await fs.open(lockPath, "wx", 0o600);
  try {
    const records = await readClarifications(filename);
    const key = duplicateKey(event);
    if (key) {
      const existing = records.find(({ event: prior }) => duplicateKey(prior) === key ||
        (prior.kind === "message" && (!event.messageId || !prior.messageId) &&
         prior.source === event.source && prior.threadId === event.threadId &&
         messageFingerprint(prior) === messageFingerprint(event)));
      if (existing) {
        requireValid(messageFingerprint(existing.event) === messageFingerprint(event), "Conflicting evidence for an existing message ID");
        return { appended: false, record: existing };
      }
    } else if (event.kind === "send-outcome") {
      validateSendOutcome(event, records);
    } else if (event.kind === "identity-resolution") {
      validateIdentityResolution(event, records);
    } else {
      validateProjectMaterial(event, records);
    }
    const version = 1;
    const sequence = records.length + 1;
    const previousHash = records.at(-1)?.hash ?? null;
    const record = { version, sequence, previousHash, event, hash: digest([version, sequence, previousHash, event]) };
    const serialized = JSON.stringify(record) + "\n";
    const size = records.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry) + "\n"), 0);
    requireValid(size + Buffer.byteLength(serialized) <= MAX_LOG, "Clarification log would exceed its size limit");
    const journal = await fs.open(filename,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      await journal.writeFile(serialized, "utf8");
      await journal.sync();
    } finally {
      await journal.close();
    }
    const pendingHead = filename + ".head.pending";
    const checkpoint = await fs.open(pendingHead, "wx", 0o600);
    try {
      await checkpoint.writeFile(JSON.stringify({ sequence, hash: record.hash }), "utf8");
      await checkpoint.sync();
    } finally {
      await checkpoint.close();
    }
    await fs.rename(pendingHead, filename + ".head");
    return { appended: true, record };
  } finally {
    try { await lock.close(); } finally { await fs.unlink(lockPath); }
  }
}

async function currentProjectMaterial(filename, projectId) {
  requireValid(path.isAbsolute(filename || ""), "An absolute clarification journal path is required");
  const records = await readClarifications(filename);
  const related = records.filter(record => record.event.projectId === projectId);
  const material = related.findLast(record => record.event.kind === "project-material");
  requireValid(material, "No reviewed clarification material snapshot exists for this project");
  requireValid(!related.some(record => record.sequence > material.sequence && isIncomingEvidence(record.event)),
    "New clarification evidence requires a fresh project review");
  validateProjectMaterial(material.event, records.slice(0, material.sequence - 1));
  return { version: 1, projectId, snapshotHash: material.hash, ...normalizeMaterial(material.event) };
}

function validateMaterialBinding(binding) {
  requireValid(binding?.version === 1 && /^[A-Z0-9]+$/.test(binding.projectId || "") &&
    typeof binding.snapshotHash === "string" && sha256.test(binding.snapshotHash), "Missing or malformed clarification evidence");
  return { version: 1, projectId: binding.projectId, snapshotHash: binding.snapshotHash, ...normalizeMaterial(binding) };
}

function comparison(snapshot) {
  const hash = value => {
    requireValid(typeof value === "string" && sha256.test(value), "Missing or invalid comparison hash");
    return value;
  };
  return {
    script: hash(snapshot.scriptSha256),
    attachments: attachments(snapshot.attachments).sort((a, b) => a.filename.localeCompare(b.filename)),
    terms: hash(snapshot.termsSha256),
    agreement: snapshot.agreement === null ? null : documentVersion(snapshot.agreement),
    generationSettings: snapshot.generationSettingsSha256 === null ? null : hash(snapshot.generationSettingsSha256),
    audio: snapshot.audioSha256 === null ? null : hash(snapshot.audioSha256)
  };
}

function classifyApprovalInvalidation(previous, current) {
  const old = comparison(previous);
  const next = comparison(current);
  const changed = Object.keys(old).filter(key => digest(old[key]) !== digest(next[key]));
  const projectReview = changed.some(key => ["script", "attachments", "terms", "agreement"].includes(key));
  const generation = projectReview || changed.includes("generationSettings");
  return { changed, stale: { projectReview, generation, submission: generation || changed.includes("audio") } };
}

module.exports = { appendClarification, readClarifications, classifyApprovalInvalidation, currentProjectMaterial, validateMaterialBinding };
