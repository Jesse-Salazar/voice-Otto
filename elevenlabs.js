const path = require("node:path");
const { randomUUID } = require("node:crypto");
const fs = require("fs-extra");
const { ApprovalError, authorizeGeneration, fingerprint, parseEvidence, sha256, verifyCurrentProjectReview } = require("./approval-evidence");
const { withWorkerLock } = require("./worker-lock");

function generationInputs() {
  const number = (name, fallback) => process.env[name] === undefined ? fallback : Number(process.env[name]);
  return {
    voice: process.env.ELEVENLABS_VOICE_ID,
    model: process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2",
    settings: {
      stability: number("ELEVENLABS_STABILITY", 0.6),
      similarity_boost: number("ELEVENLABS_SIMILARITY", 0.85),
      style: number("ELEVENLABS_STYLE_EXAGGERATION", 0.5),
      speed: number("ELEVENLABS_SPEED", 1.12),
      speaker_boost: process.env.ELEVENLABS_SPEAKER_BOOST !== "false"
    }
  };
}

async function generateAudio(projectId, text) {
  if (process.env.DRY_RUN !== "false" || process.env.ENABLE_PAID_GENERATION !== "true") {
    throw new ApprovalError("Paid generation is disabled");
  }
  return withWorkerLock(() => generateUnderLock(projectId, text));
}

async function generateUnderLock(projectId, text) {
  const { openPermit, approvalBinding } = require("./execution-permit");
  const execution = await openPermit("generation");
  if (execution.permit.trackingId !== projectId) throw new ApprovalError("Generation permit targets another tracking ID");
  const sheets = require("./googleSheets");
  const inputs = generationInputs();
  let observed = await sheets.getApprovalProject({ id: projectId });
  const approval = authorizeGeneration(observed, text, inputs);
  await verifyCurrentProjectReview(observed, parseEvidence(observed).project);
  const region = process.env.AWS_REGION;
  const bucket = process.env.AWS_BUCKET_NAME;
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/.test(region || "") || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket || "")) {
    throw new Error("Missing or invalid storage reference configuration");
  }
  const attemptId = randomUUID();
  await execution.claim(approvalBinding(observed), attemptId);
  const claimNote = `Generation attempt ${attemptId} reserved. Reconcile before any retry.`;
  await sheets.updateProject(projectId, { Status: "Processing", Notes: claimNote }, observed);
  const claimedEvidence = observed.evidence;

  async function verifyClaim() {
    observed = await sheets.getApprovalProject({ id: projectId });
    const stillApproved = row => row.status === "Processing" && row.notes === claimNote && row.evidence === claimedEvidence &&
      fingerprint(authorizeGeneration({ ...row, status: "Generation Approved" }, text, generationInputs())) === fingerprint(approval);
    if (!stillApproved(observed)) throw new ApprovalError("Generation approval changed during execution");
    if (await verifyCurrentProjectReview(observed, parseEvidence(observed).project)) {
      observed = await sheets.getApprovalProject({ id: projectId });
      if (!stillApproved(observed)) throw new ApprovalError("Generation approval changed during source verification");
    }
    await execution.validate(approvalBinding(observed), attemptId);
  }

  await verifyClaim();
  const review = parseEvidence(observed).project;
  const record = require("./recovery-manifest").createRecoveryAttempt({
    operation: "generation", attemptId, permitId: execution.permit.id, projectId: review.clarification.projectId, trackingId: projectId,
    approvalSha256: sha256(claimedEvidence), clarificationSnapshotHash: review.clarification.snapshotHash
  });
  await record("generation-started");
  await verifyClaim();
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(inputs.voice)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: inputs.model, voice_settings: inputs.settings })
    }
  );
  if (!response.ok) throw new Error(`Audio generation returned HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error("Audio generation returned an empty file");
  await record("audio-generated", { audioSha256: sha256(buffer) });
  await verifyClaim();
  const filename = `audio_${projectId}_${Date.now()}.mp3`;
  if (process.env.SAVE_LOCAL_AUDIO !== "false") {
    try {
      const dir = path.join(__dirname, "tmp_audio");
      await fs.ensureDir(dir);
      await fs.writeFile(path.join(dir, filename), buffer, { flag: "wx" });
    } catch (error) {
      console.warn("Could not save local audio:", error.code);
    }
    await verifyClaim();
  }
  const audioUrl = `https://${bucket}.s3.${region}.amazonaws.com/${filename}`;
  await record("storage-attempted", { storageUrl: audioUrl });
  await verifyClaim();
  const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
  const { fromEnv } = require("@aws-sdk/credential-provider-env");
  const client = new S3Client({ region, credentials: fromEnv(), maxAttempts: 1 });
  try {
    const result = await client.send(new PutObjectCommand({
      Bucket: bucket, Key: filename, Body: buffer, ContentType: "audio/mpeg"
    }));
    const status = result?.$metadata?.httpStatusCode;
    if (!(status >= 200 && status < 300)) throw new Error("Storage did not confirm staging");
  } finally { client.destroy(); }
  await record("storage-confirmed");
  await verifyClaim();
  await sheets.updateProject(projectId, {
    Status: "Pending Submission Approval", "Audio File URL": audioUrl,
    "Voice Settings": JSON.stringify(inputs.settings), Notes: ""
  }, observed);
  await record("published");
  return filename;
}

module.exports = { generateAudio, generationInputs };
