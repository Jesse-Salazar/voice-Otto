const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { parseEvidence, sha256, fingerprint } = require("./approval-evidence");
const { projectIdentity } = require("./voice123-projects");
const { readClarifications } = require("./clarification-log");
const { validateLocalPaths } = require("./connectivity-local");

const store = path.join(__dirname, ".voice-otto-local", "permits");
const operations = ["discovery", "generation", "submission"];
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const id = /^[A-Za-z0-9_-]{1,100}$/;
const maxLifetime = 60 * 60 * 1000;
const ensure = (ok, message) => { if (!ok) throw new Error(message); };
const isHash = value => typeof value === "string" && hash.test(value);
const operatorRef = value => typeof value === "string" && Boolean(value.trim()) && value.length <= 300 && !/[\r\n\u0000]/u.test(value);
const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const syntheticProject = value => typeof value === "string" && /^SYNTH11B[A-Z0-9]+$/.test(value);
const fixtureProject = value => typeof value === "string" && /^SYNTH[A-Z0-9]+$/.test(value);

async function privateStore(directory, create = false) {
  ensure(path.isAbsolute(directory), "Invalid permit store");
  if (create) await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  const stat = await fs.lstat(directory);
  ensure(stat.isDirectory() && !(stat.mode & 0o077) && await fs.realpath(directory) === directory, "Permit store must be a private local directory");
}

async function read(filename, optional = false) {
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch(error => { if (optional && error.code === "ENOENT") return null; throw error; });
  if (!file) return undefined;
  try {
    const stat = await file.stat();
    ensure(stat.isFile() && !(stat.mode & 0o077) && stat.size <= 8192, "Invalid permit store record");
    try { return JSON.parse(await file.readFile("utf8")); } catch { throw new Error("Malformed permit store record"); }
  } finally { await file.close(); }
}

async function write(filename, value) {
  const file = await fs.open(filename, "wx", 0o600).catch(error => {
    if (error.code === "EEXIST") throw new Error("Permit record already exists; replay or competing claim blocked");
    throw error;
  });
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally { await file.close(); }
}

function validate(permit, permitId) {
  ensure(permit?.version === 1 && permit.id === permitId && uuid.test(permitId) &&
    operations.includes(permit.operation) && typeof permit.projectId === "string" && /^[A-Z0-9]+$/.test(permit.projectId) &&
    typeof permit.trackingId === "string" && id.test(permit.trackingId) &&
    isHash(permit.approvalSha256) && isHash(permit.clarificationSha256) &&
    (permit.operation === "submission" ? isHash(permit.audioSha256) : permit.audioSha256 === null) &&
    timestamp(permit.createdAt) && timestamp(permit.expiresAt) &&
    Date.parse(permit.expiresAt) > Date.parse(permit.createdAt) &&
    Date.parse(permit.expiresAt) - Date.parse(permit.createdAt) <= maxLifetime &&
    operatorRef(permit.operator) && operatorRef(permit.authorization), "Malformed execution permit");
}

function permitFile(directory, permitId, suffix = ".permit") {
  ensure(typeof permitId === "string" && uuid.test(permitId), "A valid execution permit ID is required");
  return path.join(directory, permitId + suffix);
}

function claimAnchor(directory, permitId) {
  return permitFile(path.dirname(directory), permitId, ".consumed");
}

async function claimRecord(directory, permitId, audited = false) {
  const claim = await read(permitFile(directory, permitId, ".claim"), true);
  if (audited) {
    const anchor = await read(claimAnchor(directory, permitId), true);
    ensure((anchor === undefined && claim === undefined) ||
      (anchor !== undefined && claim !== undefined && fingerprint(anchor) === fingerprint(claim)),
    "Inconsistent permit consumption records; manual reconciliation required");
  }
  if (claim !== undefined) {
    ensure(claim?.permitId === permitId && typeof claim.attemptId === "string" && uuid.test(claim.attemptId) &&
      timestamp(claim.consumedAt), "Inconsistent permit claim; manual reconciliation required");
  }
  return claim;
}

async function revokedRecord(directory, permitId) {
  const revoked = await read(permitFile(directory, permitId, ".revoked"), true);
  if (revoked !== undefined) {
    ensure(revoked?.permitId === permitId && timestamp(revoked.at) && operatorRef(revoked.operator) &&
      operatorRef(revoked.authorization), "Inconsistent permit revocation");
  }
  return revoked;
}

async function issuanceAudit(directory, permit) {
  const record = await read(permitFile(directory, permit.id, ".issued"));
  ensure(record?.version === 1 && record.event === "interactive-issuance" &&
    record.permitId === permit.id && record.at === permit.createdAt &&
    record.projectId === permit.projectId && record.trackingId === permit.trackingId &&
    record.operation === permit.operation && record.operator === permit.operator &&
    record.authorization === permit.authorization && Number.isSafeInteger(record.uid) && record.uid >= 0 &&
    record.confirmation === `ISSUE ${permit.projectId} ${permit.operation}` && isHash(record.summarySha256) &&
    record.summary && fingerprint(record.summary) === record.summarySha256 &&
    record.permitSha256 === fingerprint(permit) && record.hash === fingerprint({ ...record, hash: undefined }),
  "Corrupted permit issuance audit");
}

async function auditedStore(directory, initialize = false) {
  const marker = path.join(path.dirname(directory), "permit-store.initialized");
  const initialized = await read(marker, true);
  if (initialized === undefined && initialize) {
    const existing = await fs.lstat(directory).catch(error => { if (error.code !== "ENOENT") throw error; });
    ensure(!existing, "Permit store initialization record is missing; manual reconciliation required");
    await write(marker, { version: 1 });
    await privateStore(directory, true);
  } else {
    ensure(initialized?.version === 1, "Permit store initialization record is missing or corrupt");
    await privateStore(directory);
  }
}

async function issuePermitRecord(input, { directory = store, now = Date.now(), audit, revalidate } = {}) {
  ensure(directory !== store, "Production permit issuance is disabled");
  ensure(fixtureProject(input.projectId), "Only synthetic fixture permits can be issued in this phase");
  ensure(!syntheticProject(input.projectId) || (audit && revalidate),
    "Synthetic issuance requires an isolated audited permit store");
  if (audit) await auditedStore(directory, true);
  else await privateStore(directory, true);
  const lockPath = path.join(directory, "issuance.lock");
  const lock = await fs.open(lockPath, "wx", 0o600);
  try {
    const permit = {
      version: 1, id: randomUUID(), operation: input.operation, projectId: input.projectId,
      trackingId: input.trackingId, approvalSha256: input.approvalSha256, clarificationSha256: input.clarificationSha256,
      audioSha256: input.audioSha256 ?? null, operator: input.operator, authorization: input.authorization,
      createdAt: new Date(now).toISOString(), expiresAt: input.expiresAt
    };
    validate(permit, permit.id);
    const files = new Set(await fs.readdir(directory));
    if (audit) {
      for (const name of await fs.readdir(path.dirname(directory))) {
        if (name.endsWith(".consumed")) {
          ensure(files.has(name.slice(0, -9) + ".permit"), "Consumed permit record is missing; manual reconciliation required");
        }
      }
    }
    for (const file of files) {
      if (file.endsWith(".issued")) {
        ensure(files.has(file.slice(0, -7) + ".permit"), "Incomplete issuance audit; manual reconciliation required");
      }
      if (!file.endsWith(".permit")) continue;
      const priorId = file.slice(0, -7);
      const prior = await read(permitFile(directory, priorId));
      validate(prior, priorId);
      if (syntheticProject(prior.projectId)) await issuanceAudit(directory, prior);
      if (prior.projectId !== permit.projectId || prior.operation !== permit.operation) continue;
      const claim = await claimRecord(directory, priorId, syntheticProject(prior.projectId));
      if (claim) {
        const resolved = await read(permitFile(directory, priorId, ".reconciled"), true);
        ensure(resolved?.permitId === priorId && resolved.attemptId === claim.attemptId &&
          operatorRef(resolved.operator) && operatorRef(resolved.authorization) && timestamp(resolved.at) &&
          ["confirmed-complete", "confirmed-no-action", "confirmed-failed"].includes(resolved.outcome),
        "A consumed permit requires manual reconciliation before replacement");
      } else {
        ensure(await revokedRecord(directory, priorId) || Date.parse(prior.expiresAt) <= now,
          "A current unconsumed permit already exists for this project and operation");
      }
    }
    if (audit) {
      await revalidate();
      const record = { version: 1, event: "interactive-issuance", permitId: permit.id, at: permit.createdAt,
        projectId: permit.projectId, trackingId: permit.trackingId, operation: permit.operation,
        operator: permit.operator, authorization: permit.authorization, uid: audit.uid,
        confirmation: audit.confirmation, summary: audit.summary, summarySha256: audit.summarySha256,
        permitSha256: fingerprint(permit) };
      await write(permitFile(directory, permit.id, ".issued"), { ...record, hash: fingerprint(record) });
      await issuanceAudit(directory, permit);
    }
    await write(permitFile(directory, permit.id), permit);
    return permit;
  } finally {
    try { await lock.close(); } finally { await fs.unlink(lockPath); }
  }
}

async function issuePermit(input, { directory = store, now = Date.now() } = {}) {
  return issuePermitRecord(input, { directory, now });
}

async function runInteractiveIssuance(args, terminal) {
  const { input, options, output } = await require("./issue-permit").prepareIssuance(args, terminal);
  const permit = await issuePermitRecord(input, options);
  output.write(`Issued synthetic permit ${permit.id}, expires ${permit.expiresAt}\n`);
  return permit;
}

async function revokePermit(permitId, human, directory = store) {
  await privateStore(directory);
  validate(await read(permitFile(directory, permitId)), permitId);
  ensure(operatorRef(human.operator) && operatorRef(human.authorization), "Human revocation evidence is required");
  await write(permitFile(directory, permitId, ".revoked"),
    { permitId, operator: human.operator, authorization: human.authorization, at: new Date().toISOString() });
}

async function reconcilePermit(permitId, human, directory = store) {
  await privateStore(directory);
  const permit = await read(permitFile(directory, permitId));
  validate(permit, permitId);
  const claim = await claimRecord(directory, permitId, syntheticProject(permit.projectId));
  ensure(claim && operatorRef(human.operator) && operatorRef(human.authorization) &&
    ["confirmed-complete", "confirmed-no-action", "confirmed-failed"].includes(human.outcome),
  "A consumed attempt and verified human reconciliation are required");
  await write(permitFile(directory, permitId, ".reconciled"), { permitId, attemptId: claim.attemptId,
    operator: human.operator, authorization: human.authorization, outcome: human.outcome, at: new Date().toISOString() });
}

async function openPermit(operation, { permitId = process.env.VOICE_OTTO_PERMIT_ID, directory = store, clock = Date.now } = {}) {
  const filename = permitFile(directory, permitId);
  await privateStore(directory);
  const original = await read(filename);
  validate(original, permitId);
  ensure(directory !== store || !fixtureProject(original.projectId), "Synthetic permits are disabled in the production store");
  ensure(!operation || original.operation === operation, "Execution permit operation does not match");
  const originalHash = fingerprint(original);
  const audited = syntheticProject(original.projectId);

  async function check(binding, attemptId) {
    const current = await read(filename);
    validate(current, permitId);
    ensure(fingerprint(current) === originalHash, "Execution permit changed");
    if (audited) await auditedStore(directory);
    if (directory === store || audited) await issuanceAudit(directory, current);
    ensure(Date.parse(current.createdAt) <= clock() && clock() < Date.parse(current.expiresAt), "Execution permit is expired or not yet valid");
    ensure(!await revokedRecord(directory, permitId), "Execution permit is revoked");
    const claim = await claimRecord(directory, permitId, audited);
    if (claim) {
      ensure(Date.parse(claim.consumedAt) >= Date.parse(current.createdAt) &&
        Date.parse(claim.consumedAt) < Date.parse(current.expiresAt), "Inconsistent permit consumption timestamp");
    } else {
      ensure(await read(permitFile(directory, permitId, ".reconciled"), true) === undefined,
        "Inconsistent reconciliation without a permit claim");
    }
    ensure(attemptId ? claim?.attemptId === attemptId : !claim, "Execution permit is consumed or its claim does not match");
    if (binding) {
      ensure(["projectId", "trackingId", "approvalSha256", "clarificationSha256"].every(key => current[key] === binding[key]) &&
        current.audioSha256 === (binding.audioSha256 ?? null), "Execution permit does not match current project, tracking ID, or evidence");
    }
  }

  await check();
  return {
    permit: Object.freeze(original),
    validate: check,
    async claim(binding, attemptId) {
      ensure(typeof attemptId === "string" && uuid.test(attemptId), "Invalid permit attempt ID");
      const lockPath = path.join(directory, "issuance.lock");
      const lock = await fs.open(lockPath, "wx", 0o600);
      try {
        await check(binding);
        const claim = { permitId, attemptId, consumedAt: new Date(clock()).toISOString() };
        if (audited) await write(claimAnchor(directory, permitId), claim);
        await write(permitFile(directory, permitId, ".claim"), claim);
        await check(binding, attemptId);
      } finally {
        try { await lock.close(); } finally { await fs.unlink(lockPath); }
      }
    }
  };
}

function approvalBinding(row, audioSha256) {
  const evidence = parseEvidence(row);
  return { projectId: projectIdentity(row.url).id, trackingId: row.id,
    approvalSha256: sha256(row.evidence), clarificationSha256: evidence.project?.clarification?.snapshotHash,
    audioSha256 };
}

async function discoveryClarification(projectId) {
  const paths = await validateLocalPaths(process.env);
  const records = await readClarifications(paths.VOICE_OTTO_CLARIFICATION_LOG);
  return records.findLast(record => record.event.projectId === projectId)?.hash ?? fingerprint([]);
}

module.exports = { issuePermit, runInteractiveIssuance, openPermit, revokePermit, reconcilePermit, approvalBinding, discoveryClarification, syntheticProject };
