const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const location = path.join(__dirname, ".voice-otto-local", "recovery");
const digest = /^[a-f0-9]{64}$/;
const order = {
  discovery: ["discovery-attempted", "discovery-persisted"],
  generation: ["generation-started", "audio-generated", "storage-attempted", "storage-confirmed", "published"],
  submission: ["submission-prepared", "submission-attempted", "submission-confirmed", "submission-audited"]
};
const validId = value => typeof value === "string" && /^[a-z0-9_-]{1,100}$/i.test(value);
const validHash = value => typeof value === "string" && digest.test(value);
const required = (condition, message) => { if (!condition) throw new Error(message); };

function storageReference(value) {
  const url = new URL(value);
  required(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash &&
    url.pathname !== "/", "Recovery requires a plain HTTPS storage reference");
  return url.href;
}

async function privateDirectory(directory, create = false) {
  if (create) await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  const stat = await fs.lstat(directory);
  required(stat.isDirectory() && !(stat.mode & 0o077) && await fs.realpath(directory) === directory,
    "Recovery directory must be private and local");
}

function checkRecord(record, previous) {
  const { version, operation, attemptId, permitId, event, projectId, trackingId, approvalSha256,
    clarificationSnapshotHash, audioSha256, storageUrl, at } = record;
  const steps = operation === "submission" && !permitId ? order.submission.slice(1) : order[operation];
  const expected = steps?.[previous ? steps.indexOf(previous.event) + 1 : 0];
  required(version === 1 && validId(attemptId) && validId(projectId) && validId(trackingId) &&
    validHash(approvalSha256) && validHash(clarificationSnapshotHash) && Number.isFinite(Date.parse(at)) &&
    (permitId === undefined || /^[a-f0-9-]{36}$/.test(permitId)) &&
    expected && event === expected, "Invalid recovery record or transition");
  if (previous) {
    required(["operation", "attemptId", "permitId", "projectId", "trackingId", "approvalSha256", "clarificationSnapshotHash"]
      .every(key => record[key] === previous[key]) && at >= previous.at &&
      (!previous.audioSha256 || previous.audioSha256 === audioSha256) &&
      (!previous.storageUrl || previous.storageUrl === storageUrl), "Conflicting recovery attempt evidence");
  }
  required(operation === "discovery" || event === "generation-started" ? audioSha256 === null : validHash(audioSha256), "Missing recovery audio hash");
  if (operation === "discovery" || ["generation-started", "audio-generated"].includes(event)) {
    required(storageUrl === null, "Unexpected recovery storage reference");
  } else {
    required(typeof storageUrl === "string" && storageReference(storageUrl) === storageUrl, "Invalid recovery storage reference");
  }
}

function createRecoveryAttempt({ operation, projectId, trackingId, approvalSha256, clarificationSnapshotHash,
  attemptId = randomUUID(), permitId },
  directory = location) {
  required(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(attemptId), "Invalid recovery attempt ID");
  const filename = path.join(directory, attemptId + ".jsonl");
  let previous;
  return async (event, data = {}) => {
    const record = {
      version: 1, operation, attemptId, permitId, event, projectId, trackingId, approvalSha256, clarificationSnapshotHash,
      audioSha256: data.audioSha256 ?? previous?.audioSha256 ?? null,
      storageUrl: data.storageUrl ?? previous?.storageUrl ?? null,
      at: new Date().toISOString()
    };
    checkRecord(record, previous);
    await privateDirectory(directory, true);
    const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW |
      (previous ? 0 : constants.O_CREAT | constants.O_EXCL);
    const file = await fs.open(filename, flags, 0o600);
    try {
      await file.writeFile(JSON.stringify(record) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    previous = record;
    return record;
  };
}

async function readRecoveryAttempts(directory = location) {
  try {
    await privateDirectory(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const results = [];
  for (const name of (await fs.readdir(directory)).sort()) {
    if (!/^[a-f0-9-]{36}\.jsonl$/i.test(name)) continue;
    const location = path.join(directory, name);
    const file = await fs.open(location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      required(stat.isFile() && !(stat.mode & 0o077) && stat.size <= 65536, "Invalid recovery file");
      const text = await file.readFile("utf8");
      required(text.endsWith("\n"), "Incomplete recovery record; reconcile manually");
      const events = [];
      for (const line of text.trimEnd().split("\n")) {
        const event = JSON.parse(line);
        checkRecord(event, events.at(-1));
        required(name === event.attemptId + ".jsonl", "Recovery attempt identity mismatch");
        events.push(event);
      }
      results.push(events);
    } finally {
      await file.close();
    }
  }
  return results;
}

function classifyRecovery(attempt, offlineRows) {
  const last = attempt.at(-1);
  const match = (offlineRows || []).filter(row => row.projectId === last.projectId && row.trackingId === last.trackingId &&
    row.storageUrl === last.storageUrl && row.audioSha256 === last.audioSha256);
  const statuses = {
    "discovery-attempted": "discovery-outcome-unknown",
    "discovery-persisted": "discovery-persisted",
    "generation-started": "provider-outcome-unknown",
    "audio-generated": "generated-but-unstaged",
    "storage-attempted": "storage-outcome-unknown",
    "storage-confirmed": match.length === 1 ? "staged-with-offline-row-match" : "staged-orphan-candidate",
    "published": offlineRows && match.length !== 1 ? "published-reference-unverified" : "published",
    "submission-prepared": "submission-preparation-requires-review",
    "submission-attempted": "submission-outcome-unknown",
    "submission-confirmed": "confirmed-audit-pending",
    "submission-audited": "submitted-and-audited"
  };
  const finding = statuses[last.event];
  return { ...last, finding,
    manualReconciliation: !["discovery-persisted", "published", "submitted-and-audited"].includes(finding),
    automaticRetryAllowed: false, cleanupAuthorized: false };
}

if (require.main === module) {
  if (process.argv.length !== 2) {
    console.error("Usage: node recovery-manifest.js");
    process.exitCode = 1;
  } else {
    readRecoveryAttempts().then(attempts => console.log(JSON.stringify(attempts.map(attempt => classifyRecovery(attempt)), null, 2)))
      .catch(() => { console.error("Recovery manifest could not be verified. Reconcile manually."); process.exitCode = 1; });
  }
}

module.exports = { createRecoveryAttempt, readRecoveryAttempts, classifyRecovery };
