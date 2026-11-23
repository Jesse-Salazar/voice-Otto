async function main(args = process.argv.slice(2)) {
  require("dotenv").config();
  if (process.env.DRY_RUN !== "false" || process.env.ENABLE_VOICE123_SUBMISSION !== "true") {
    throw new Error("Voice123 submission is disabled");
  }
  const sheets = require("./googleSheets");
  const { uploadAudio } = require("./voice123");
  const { permit } = await require("./execution-permit").openPermit("submission");
  if (args.length === 3 && args[0] === "--local") {
    if (args[1] !== permit.trackingId) throw new Error("Submission permit targets another tracking ID");
    const project = await sheets.getApprovalProject({ id: permit.trackingId, voice123Id: permit.projectId });
    return uploadAudio(project.url, args[2]);
  }
  if (args.length) throw new Error("Usage: node upload.js [--local TRACKING_ID AUDIO_FILE]");
  const project = await sheets.getApprovalProject({ id: permit.trackingId, voice123Id: permit.projectId });
  return uploadAudio(project.url);
}

if (require.main === module) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = main;
