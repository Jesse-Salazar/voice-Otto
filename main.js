require("dotenv").config({ path: ".env" });

async function main() {
  const dryRun = process.env.DRY_RUN !== "false";
  const { checkInvites } = require("./voice123");

  if (dryRun) {
    const report = await checkInvites({ dryRun: true });
    console.log(JSON.stringify(report, null, 2));
    if (report.sheetsCheck === "Unavailable" || report.projects.some(project => project.error)) process.exitCode = 1;
    return;
  }

  const { permit } = await require("./execution-permit").openPermit();
  if (permit.operation === "discovery") return checkInvites({ dryRun: false });
  if (permit.operation !== "generation" || process.env.ENABLE_PAID_GENERATION !== "true") {
    throw new Error("The named operation is not enabled for this workflow");
  }

  require("./validateEnv")();
  const { generateAudio } = require("./elevenlabs");
  const { getApprovalProject } = require("./googleSheets");
  const row = await getApprovalProject({ id: permit.trackingId, voice123Id: permit.projectId });
  return generateAudio(row.id, row.script);
}

if (require.main === module) {
  main().catch(error => {
    if (process.env.DRY_RUN === "false") console.error("Workflow failed:", error);
    else console.error(JSON.stringify({ dryRun: true, error: error.message }));
    process.exitCode = 1;
  });
}

module.exports = main;
