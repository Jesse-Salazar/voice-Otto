const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { parseArgs } = require("node:util");
const { runInteractiveIssuance, approvalBinding, syntheticProject } = require("./execution-permit");
const { authorizeProjectReview, authorizeGeneration, authorizeSubmission, verifyCurrentProjectReview,
  parseEvidence, fingerprint, sha256 } = require("./approval-evidence");
const { readClarifications } = require("./clarification-log");
const { stageAudio } = require("./approval-audio");
const { projectIdentity } = require("./voice123-projects");

const effects = {
  discovery: ["Create one Sheets Needs Review row", "Append matching local processing history"],
  generation: ["Reserve the row in Sheets", "Call paid ElevenLabs generation", "Stage audio in S3 and update Sheets"],
  submission: ["Use the approved staged audio", "Accept the invitation if needed", "Attach and submit the audio to Voice123",
    "Update the Sheets submission audit; a proposal allowance may be consumed"]
};
const check = (condition, message) => { if (!condition) throw new Error(message); };
const reference = value => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value);

async function workspace(directory, uid) {
  const temp = await fs.realpath(os.tmpdir());
  check(typeof directory === "string" && path.isAbsolute(directory), "An absolute synthetic workspace is required");
  const root = await fs.realpath(directory);
  const stat = await fs.lstat(root);
  check(path.dirname(root) === temp && /^voice-otto-issuance-[A-Za-z0-9]+$/.test(path.basename(root)) &&
    stat.isDirectory() && stat.uid === uid && !(stat.mode & 0o077), "An operator-owned private synthetic workspace is required");
  return root;
}

async function fixture(root, name, uid) {
  const file = await fs.open(path.join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    check(stat.isFile() && stat.uid === uid && !(stat.mode & 0o077) && stat.size <= 1024 * 1024,
      "Invalid private synthetic fixture");
    try { return JSON.parse(await file.readFile("utf8")); } catch { throw new Error("Malformed synthetic fixture"); }
  } finally { await file.close(); }
}

async function prepare(root, request, account, now) {
  const { projectId, trackingId, operation, authorization, audioSha256 } = request;
  const grants = await fixture(root, "authorizations.json", account.uid);
  check(Array.isArray(grants), "Invalid operator authorization registry");
  const matches = grants.filter(grant => grant?.reference === authorization);
  const grant = matches[0];
  check(matches.length === 1 && grant.uid === account.uid && grant.operator === account.username &&
    grant.projectId === projectId && grant.trackingId === trackingId && grant.operation === operation &&
    grant.status === "active" && Date.parse(grant.createdAt) <= now && Date.parse(grant.expiresAt) > now,
  "Operator authorization is missing, ambiguous, stale, revoked, or out of scope");

  const rows = await fixture(root, "projects.json", account.uid);
  check(Array.isArray(rows), "Invalid project registry");
  const candidates = rows.filter(row => row?.id === trackingId || projectIdentity(row?.url)?.id === projectId);
  const row = candidates[0];
  check(candidates.length === 1 && row?.id === trackingId && projectIdentity(row.url)?.id === projectId,
    "Project and tracking identity are missing, ambiguous, or mismatched");

  const review = authorizeProjectReview(row, now);
  const evidence = parseEvidence(row);
  const journal = path.join(root, "clarifications.jsonl");
  const sources = path.join(root, "sources");
  await verifyCurrentProjectReview(row, review, { journal, sources, attachmentDirectory: sources,
    historyFile: path.join(root, "synthetic-history.json") });

  const approvalExpiries = [review.expiresAt];
  const reviewedDecisions = { project: fingerprint(review) };
  let binding = approvalBinding(row, audioSha256);
  if (operation === "discovery") {
    const plan = row.discoveryPlan;
    check(row.status === "Pending Discovery" && plan?.voice123Id === projectId &&
      projectIdentity(plan.url)?.id === projectId && plan.status === "Needs Review" && plan.script === null,
    "A matching pending discovery plan that writes Needs Review is required");
    const records = await readClarifications(journal);
    check(records.some(record => record.hash === review.clarification.snapshotHash) &&
      records.findLast(record => record.event.projectId === projectId)?.hash === review.clarification.snapshotHash,
    "Clarification journal changed; refresh the discovery review");
    binding = { ...binding, approvalSha256: fingerprint(plan) };
  } else {
    const generationRow = { ...row, status: operation === "generation" ? row.status : "Generation Approved" };
    const generation = authorizeGeneration(generationRow, row.script, row.generationInputs, now);
    check(row.generationInputs, "Current generation inputs are required");
    reviewedDecisions.generation = fingerprint(generation);
    approvalExpiries.push(generation.expiresAt);
    if (operation === "submission") {
      const { approval } = authorizeSubmission(row, audioSha256, { inputs: row.generationInputs, now });
      check(typeof row.stagedAudio === "string" && /^[A-Za-z0-9_-]+\.(mp3|wav)$/.test(row.stagedAudio),
        "A local upload-ready fixture is required");
      const audio = path.join(root, row.stagedAudio);
      const stat = await fs.lstat(audio);
      check(stat.isFile() && stat.uid === account.uid && !(stat.mode & 0o077), "Invalid private audio fixture");
      const staged = await stageAudio(audio);
      try { check(await staged.digest() === audioSha256, "Staged audio SHA-256 differs from the approved audio"); }
      finally { await staged.cleanup(); }
      reviewedDecisions.submission = fingerprint(approval);
      approvalExpiries.push(approval.expiresAt);
    }
  }

  const summary = { mode: "Synthetic offline issuance; execution disabled in production", operation, projectId, trackingId,
    status: row.status, scriptSha256: sha256(row.script), scriptCharacters: row.script.length,
    approvalSha256: sha256(row.evidence), reviewedDecisions, operationBindingSha256: binding.approvalSha256,
    clarificationSha256: binding.clarificationSha256, rightsClearanceSha256: fingerprint(review.rights),
    ...(operation === "submission" ? { audioSha256, destination: `Voice123 project ${projectId}` } : {}),
    operator: account.username, authorization, authorizationSha256: fingerprint(grant),
    latestExpiry: new Date(Math.min(Date.parse(grant.expiresAt), ...approvalExpiries.map(Date.parse))).toISOString(),
    requestedMinutes: request.minutes, expectedEffectsIfExecuted: effects[operation] };
  return { summary, binding };
}

async function prepareIssuance(args, { input = process.stdin, output = process.stdout } = {}) {
  check(input.isTTY === true && output.isTTY === true, "Interactive terminal input and output are required");
  const { values, tokens } = parseArgs({ args, tokens: true, options: {
    workspace: { type: "string" }, project: { type: "string" }, tracking: { type: "string" },
    operation: { type: "string" }, authorization: { type: "string" }, "audio-sha256": { type: "string" },
    minutes: { type: "string" }
  } });
  check(tokens.filter(token => token.name === "operation").length === 1,
    "Exactly one operation is required");
  check(new Set(tokens.map(token => token.name)).size === tokens.length, "Repeated issuance options are ambiguous");
  const request = { projectId: values.project, trackingId: values.tracking, operation: values.operation,
    authorization: values.authorization, audioSha256: values["audio-sha256"], minutes: Number(values.minutes ?? 15) };
  check(syntheticProject(request.projectId) && /^synthetic-[A-Za-z0-9_-]{1,80}$/.test(request.trackingId || ""),
    "Only reserved synthetic project and tracking IDs are permitted");
  check(Object.hasOwn(effects, request.operation) && reference(request.authorization) &&
    Number.isInteger(request.minutes) && request.minutes >= 1 && request.minutes <= 60 &&
    (request.operation === "submission" ? /^[a-f0-9]{64}$/.test(request.audioSha256 || "") : request.audioSha256 === undefined),
  "Invalid operation, authorization reference, lifetime, or audio hash");
  const account = os.userInfo();
  check(reference(account.username) && account.uid === process.getuid(), "Cannot verify the local operator account");
  const root = await workspace(values.workspace, account.uid);
  const initial = await prepare(root, request, account, Date.now());
  const summarySha256 = fingerprint(initial.summary);
  const confirmation = `ISSUE ${request.projectId} ${request.operation}`;
  output.write(JSON.stringify(initial.summary, null, 2) + "\n");
  const terminal = readline.createInterface({ input, output, terminal: true });
  try {
    const answer = await new Promise(resolve => {
      terminal.once("close", () => resolve(undefined));
      terminal.once("SIGINT", () => terminal.close());
      terminal.question(`Type ${confirmation} to issue the synthetic permit: `, resolve);
    });
    check(answer === confirmation, "Permit confirmation was missing or incorrect");
  } finally { terminal.close(); }

  const now = Date.now();
  const expiresAt = new Date(Math.min(now + request.minutes * 60_000, Date.parse(initial.summary.latestExpiry))).toISOString();
  return { output, input: { ...initial.binding, operation: request.operation, operator: account.username,
    authorization: request.authorization, expiresAt }, options: {
    directory: path.join(root, "permits"), now,
    audit: { uid: account.uid, summary: initial.summary, summarySha256, confirmation },
    revalidate: async () => {
      const current = await prepare(root, request, account, Date.now());
      check(fingerprint(current.summary) === summarySha256 && Date.parse(expiresAt) > Date.now(),
        "Authorization changed since the review summary");
    }
  } };
}

module.exports = { runIssuance: runInteractiveIssuance, prepareIssuance };

if (require.main === module) {
  runInteractiveIssuance(process.argv.slice(2)).catch(error => {
    // Paths, fixture data, and argument values from unexpected errors stay local.
    const safe = error.code ? "Unable to access the required private local records or invalid command options." : error.message;
    console.error(safe);
    process.exitCode = 1;
  });
}
