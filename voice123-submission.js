const { randomUUID } = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const { projectIdentity } = require("./voice123-projects");
const { ApprovalError, authorizeSubmission, fingerprint, sha256, parseEvidence, attemptNote, verifyCurrentProjectReview } = require("./approval-evidence");
const { stageAudio } = require("./approval-audio");
const { generationInputs } = require("./elevenlabs");

const { withWorkerLock } = require("./worker-lock");

const { inspectProposalPage } = require("./voice123-proposal-controls");

async function submitApprovedAudio(projectUrl, audioPath, options) {
  if (process.env.DRY_RUN !== "false" || process.env.ENABLE_VOICE123_SUBMISSION !== "true") {
    throw new ApprovalError("Voice123 submission is disabled");
  }
  const target = projectIdentity(projectUrl);
  if (!target) throw new ApprovalError("Invalid Voice123 project");
  return withWorkerLock(() => submitUnderLock(target, audioPath, options));
}

async function downloadApprovedAudio(row, execution, approvalBinding) {
  const evidence = parseEvidence(row);
  authorizeSubmission(row, evidence.submission?.audioSha256, { inputs: generationInputs() });
  await verifyCurrentProjectReview(row, evidence.project);
  await execution.validate(approvalBinding(row, evidence.submission.audioSha256));
  if (evidence.project.revisionReview.outcome !== "new invitation") {
    throw new ApprovalError("Revision submissions require separate manual handling");
  }
  const key = new URL(row.audioUrl).pathname.slice(1);
  if (!/^[\w.-]+\.(?:mp3|wav)$/i.test(key)) throw new Error("Invalid approved audio filename");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "voice-otto-download-"));
  const cleanup = () => fs.rm(directory, { recursive: true, force: true });
  try {
    const file = path.join(directory, key);
    await fs.writeFile(file, await require("./s3").downloadFile(key), { flag: "wx", mode: 0o600 });
    return { file, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function submitUnderLock(target, audioPath, { connect, handleLogin }) {
  let stage;
  let prepared;
  let browser;
  let approval;
  let attemptId;
  let executionAttemptId;
  let record;
  let sheets;
  let rowForNotes;
  try {
    const { openPermit, approvalBinding } = require("./execution-permit");
    const execution = await openPermit("submission");
    if (execution.permit.projectId !== target.id) throw new ApprovalError("Submission permit targets another project");
    sheets = require("./googleSheets");
    if (audioPath === undefined) prepared = await downloadApprovedAudio(
      await sheets.getApprovalProject({ voice123Id: target.id }), execution, approvalBinding);
    stage = await stageAudio(prepared?.file ?? audioPath);
    async function recheck() {
      const row = await sheets.getApprovalProject({ voice123Id: target.id });
      rowForNotes = row;
      let digest = await stage.digest();
      let valid = authorizeSubmission(row, digest, { attemptId, inputs: generationInputs() });
      if (await verifyCurrentProjectReview(row, valid.evidence.project)) {
        const latest = await sheets.getApprovalProject({ voice123Id: target.id });
        if (latest.evidence !== row.evidence || latest.id !== row.id) {
          throw new ApprovalError("Submission approval changed during source verification");
        }
        digest = await stage.digest();
        valid = authorizeSubmission(latest, digest, { attemptId, inputs: generationInputs() });
        rowForNotes = latest;
      }
      if (valid.evidence.project.revisionReview.outcome !== "new invitation") {
        throw new ApprovalError("Revision submissions require separate manual handling");
      }
      if (approval && (row.id !== approval.row.id || fingerprint(valid.approval) !== fingerprint(approval.decision))) {
        throw new ApprovalError("Submission approval changed during execution");
      }
      approval ||= { row, decision: valid.approval };
      await execution.validate(approvalBinding(rowForNotes, digest), executionAttemptId);
      return { row: rowForNotes, digest };
    }
    async function consume(current) {
      if (executionAttemptId) return;
      const id = randomUUID();
      const review = parseEvidence(current.row).project;
      await execution.claim(approvalBinding(current.row, current.digest), id);
      executionAttemptId = id;
      record = require("./recovery-manifest").createRecoveryAttempt({
        operation: "submission", attemptId: id, permitId: execution.permit.id, projectId: target.id,
        trackingId: current.row.id, approvalSha256: sha256(current.row.evidence),
        clarificationSnapshotHash: review.clarification.snapshotHash
      });
      await record("submission-prepared", { audioSha256: current.digest, storageUrl: current.row.audioUrl });
    }
    await recheck();
    browser = await connect();
    const page = await browser.newPage();
    await handleLogin(page);
    await page.goto(target.url, { waitUntil: "domcontentloaded" });
    const assertPage = () => {
      if (projectIdentity(page.url())?.id !== target.id) throw new ApprovalError("Voice123 project page changed");
    };

    const pathname = new URL(target.url).pathname;
    const extension = path.extname(stage.file);
    const inspect = mode => page.evaluate(inspectProposalPage, pathname, mode, extension);
    const candidateState = await inspect("state");
    if (!["ready", "disabled"].includes(candidateState)) {
      throw new ApprovalError(`Proposal controls unavailable: ${candidateState}`);
    }
    if (await inspect("existing-confirmation")) throw new ApprovalError("Voice123 already displays a submitted proposal");

    const inviteButtons = [];
    for (const button of await page.$$(".invitation-toast button")) {
      const label = await button.evaluate(element => element.innerText.trim());
      if (/^accept invite$/i.test(label)) inviteButtons.push(button);
    }
    if (inviteButtons.length > 1) throw new ApprovalError("Ambiguous invitation controls");
    if (inviteButtons.length === 1) {
      const [button] = inviteButtons;
      const current = await recheck();
      assertPage();
      if (!await button.evaluate(element => element.isConnected && element.getClientRects().length > 0 &&
        getComputedStyle(element).visibility === "visible" && getComputedStyle(element).pointerEvents !== "none" &&
        !element.matches(":disabled") && !element.closest('[disabled], [hidden], [aria-hidden="true"], [aria-disabled="true"], [inert], .disabled'))) {
        throw new ApprovalError("Accept Invite control is hidden or disabled");
      }
      await consume(current);
      await execution.validate(approvalBinding(current.row, current.digest), executionAttemptId);
      assertPage();
      await button.click();
    }

    async function useControls(action) {
      const result = await page.evaluateHandle(inspectProposalPage, pathname, "controls", extension);
      let state;
      let input;
      let submit;
      try {
        state = await result.getProperty("state");
        const value = await state.jsonValue();
        if (value !== "ready") throw new ApprovalError(`Proposal controls unavailable: ${value}`);
        input = await result.getProperty("input");
        submit = await result.getProperty("submit");
        return await action(input.asElement(), submit.asElement());
      } finally {
        await Promise.all([state, input, submit, result].filter(Boolean).map(handle => handle.dispose()));
      }
    }
    const readAttachedHash = input => input.evaluate(async element => {
      const file = element.files?.length === 1 && element.files[0];
      if (!file) return null;
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    });

    const attachment = await recheck();
    assertPage();
    await useControls(async input => {
      await consume(attachment);
      await execution.validate(approvalBinding(attachment.row, attachment.digest), executionAttemptId);
      assertPage();
      await input.uploadFile(stage.file);
    });
    const pending = await recheck();
    assertPage();
    await useControls(async input => {
      if (await readAttachedHash(input) !== attachment.digest) {
        throw new ApprovalError("Browser attachment differs from the approved audio");
      }
    });
    if (await inspect("existing-confirmation")) throw new ApprovalError("Voice123 already displays a submitted proposal");
    const id = executionAttemptId;
    // Latch before clicking. A timeout, crash, or unclear response must not trigger a retry.
    await sheets.updateProject(pending.row.id, { Status: "Submission Uncertain", Notes: attemptNote(id) }, pending.row);
    attemptId = id;
    const final = await recheck();
    assertPage();
    await useControls(async (input, submit) => {
      if (await readAttachedHash(input) !== final.digest) throw new ApprovalError("Browser attachment changed before submission");
      if (await inspect("existing-confirmation")) throw new ApprovalError("Voice123 already displays a submitted proposal");
      await record("submission-attempted", { audioSha256: final.digest, storageUrl: final.row.audioUrl });
      await recheck();
      assertPage();
      await submit.click();
    });
    const confirmation = await page.waitForFunction(inspectProposalPage, { timeout: 20000 }, pathname, "confirmation").catch(() => false);
    if (!confirmation) throw new Error("Submission outcome is uncertain. Verify it manually before any retry.");
    await record("submission-confirmed");

    const audit = await recheck();
    await sheets.updateProject(pending.row.id, {
      Status: "Uploaded", "Uploaded At": new Date().toISOString(), Notes: ""
    }, audit.row);
    await record("submission-audited");
    return true;
  } finally {
    try {
      await browser?.close();
    } finally {
      try { await stage?.cleanup(); } finally { await prepared?.cleanup(); }
    }
  }
}

module.exports = { submitApprovedAudio };
