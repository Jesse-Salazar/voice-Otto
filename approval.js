const fs = require("node:fs/promises");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { transition, parseEvidence, readCurrentClarification, verifyCurrentProjectReview } = require("./approval-evidence");
const { stageAudio } = require("./approval-audio");

async function main(args = process.argv.slice(2)) {
  const [kind, id, expiresAt, filename] = args;
  if (kind === "prepare" && args.length === 3 && /\.mp3$/i.test(expiresAt)) {
    await promisify(execFile)("ffmpeg", ["-nostdin", "-n", "-i", id, "-map", "0:a:0", "-ar", "44100",
      "-ac", "1", "-c:a", "libmp3lame", "-b:a", "128k", expiresAt]);
    console.log(`Prepared upload-ready audio at ${expiresAt}. Review this file before approving submission.`);
    return;
  }
  const revoke = kind === "revoke";
  const stage = revoke ? expiresAt : kind;
  if (!id || !["project", "generation", "submission"].includes(stage) ||
      (revoke ? args.length !== 3 : args.length !== (stage === "generation" ? 3 : 4))) {
    throw new Error("Usage: node approval.js prepare SOURCE DESTINATION.mp3 | project ID EXPIRY REVIEW_JSON | generation ID EXPIRY | submission ID EXPIRY UPLOAD_READY_AUDIO | revoke ID STAGE");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Human approval requires an interactive terminal");
  require("dotenv").config();
  if (process.env.DRY_RUN !== "false") throw new Error("Approval writes are disabled in dry-run mode");
  const sheets = require("./googleSheets");
  const { prompt } = require("inquirer");
  const row = await sheets.getApprovalProject({ id });
  const reviewer = os.userInfo().username;
  let input = { reviewer, expiresAt, revoke };
  let staged;
  try {
    if (!revoke && stage === "project") {
      const review = JSON.parse(await fs.readFile(filename, "utf8"));
      const clarification = await readCurrentClarification(row);
      if (review.clarificationSnapshotHash !== clarification.snapshotHash) {
        throw new Error("Explicitly review the current clarification snapshot before approving");
      }
      input = { ...input, script: review.script, attachmentReview: review.attachmentReview,
        revisionReview: review.revisionReview, rights: review.rights, clarification };
    }
    if (!revoke && stage !== "project") input.inputs = require("./elevenlabs").generationInputs();
    if (!revoke && stage === "submission") {
      staged = await stageAudio(filename);
      input.audioSha256 = await staged.digest();
      console.log(`Review the exact upload-ready file at ${staged.file}\nSHA-256 ${input.audioSha256}\n${row.audioUrl}`);
    }
    if (!revoke && stage !== "submission") {
      console.log(JSON.stringify(stage === "project" ? {
        script: input.script, attachmentReview: input.attachmentReview, revisionReview: input.revisionReview,
        rights: input.rights, clarification: input.clarification
      } : { script: row.script, inputs: input.inputs }, null, 2));
    }
    transition(row, stage, input);
    const review = !revoke && (stage === "project" ? input : parseEvidence(row).project);
    const proposedRow = current => stage === "project" ? { ...current, script: input.script } : current;
    if (review) await verifyCurrentProjectReview(proposedRow(row), review);
    const answer = await prompt([{
      type: "confirm", name: "confirmed", default: false,
      message: `${revoke ? "Revoke" : "Approve"} ${stage} for ${id} as ${reviewer}?`
    }]);
    if (!answer.confirmed) return;
    const fresh = await sheets.getApprovalProject({ id });
    if (JSON.stringify(fresh) !== JSON.stringify(row) || (staged && await staged.digest() !== input.audioSha256)) {
      throw new Error("Project or reviewed audio changed. Start a fresh review.");
    }
    if (review) await verifyCurrentProjectReview(proposedRow(fresh), review);
    await sheets.updateProject(id, transition(fresh, stage, input), fresh);
  } finally {
    await staged?.cleanup();
  }
}

if (require.main === module) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = main;
