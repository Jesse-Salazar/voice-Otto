const path = require("node:path");
const fs = require("node:fs/promises");
const { isDeepStrictEqual } = require("node:util");
const { projectIdentity } = require("./voice123-projects");

const APPROVED_TARGETS = new Set(["INVQUDO70", "INVQTR98G"]);

async function persistReviewProjects(report, { sheets, files, historyPath }) {
  if (!report.dryRun || report.sheetsCheck !== "Checked" || report.projects.some(project => project.error)) {
    throw new Error("A successful read-only discovery and Sheets check is required");
  }

  const candidates = report.projects.filter(project => APPROVED_TARGETS.has(project.id));
  if (new Set(candidates.map(project => project.id)).size !== candidates.length) {
    throw new Error("Duplicate persistence-test candidates");
  }
  const projects = candidates.filter(project => !project.duplicateSources?.length).map(project => {
    const identity = projectIdentity(project.url);
    if (project.status !== "Needs Review" || project.invitationStatus !== "New invitation" ||
        !identity || identity.id !== project.id || !project.title) {
      throw new Error(`Persistence-test candidate requires a new review: ${project.id}`);
    }
    return {
      voice123Id: project.id, title: project.title, url: identity.url, deadline: project.deadline,
      invitationStatus: "New invitation", status: "Needs Review", script: null, clientId: "No client ID",
      auditionFieldStatus: project.fieldStatus, attachments: project.attachments, rightsFlags: project.rightsFlags,
      proposalEligibility: project.proposalEligibility, reviewReason: project.reason
    };
  });
  const lockPath = historyPath + ".persistence-test.lock";
  const lock = await files.open(lockPath, "wx");
  const temporaryPath = historyPath + ".persistence-test.tmp";
  let temporary;
  try {
    const original = await files.readFile(historyPath, "utf8");
    const history = JSON.parse(original);
    if (!Array.isArray(history)) throw new Error("Invalid processing history");
    const existing = new Set(history.map(record => projectIdentity(record?.url)?.id));
    const newProjects = projects.filter(project => !existing.has(project.voice123Id));

    // Check local write access before appending anything to Sheets.
    if (newProjects.length) temporary = await files.open(temporaryPath, "wx");
    const created = newProjects.length ? await sheets.appendReviewProjects(newProjects) : [];
    if (created.length) {
      try {
        await temporary.writeFile(JSON.stringify([...history, ...created], null, 2) + "\n");
        await temporary.sync();
        await temporary.close();
        if (await files.readFile(historyPath, "utf8") !== original) throw new Error("History changed during the test");
        await files.rename(temporaryPath, historyPath);
      } catch {
        throw new Error(`Sheets appended ${created.map(project => `${project.voice123Id}/${project.id}`).join(", ")} but history could not be updated. Reconcile those rows before retrying.`);
      }
    }
    return {
      created: created.map(({ voice123Id, id, status }) => ({ voice123Id, id, status })),
      skipped: report.projects.filter(project => !created.some(record => record.voice123Id === project.id)).map(project => ({
        voice123Id: project.id, reason: APPROVED_TARGETS.has(project.id) ? "Existing record" : "Outside test scope"
      }))
    };
  } finally {
    try {
      if (temporary) {
        await temporary.close().catch(() => {});
        await files.unlink(temporaryPath).catch(error => { if (error.code !== "ENOENT") throw error; });
      }
    } finally {
      await lock.close();
      await files.unlink(lockPath);
    }
  }
}

async function main(args) {
  if (args.length !== 1 || args[0] !== "--write-needs-review") {
    console.log("Persistence test is inactive. The explicit --write-needs-review flag is required for an approved live test.");
    return;
  }
  require("dotenv").config({ path: ".env" });
  if (process.env.DRY_RUN !== "false") throw new Error("Persistence writes are disabled in dry-run mode");
  throw new Error("Legacy persistence is disabled; use one project-specific discovery execution permit");
}

function verifyReadback(report, result, rows, history) {
  return [...APPROVED_TARGETS].map(id => {
    const expected = report.projects.find(project => project.id === id);
    const matchingRows = rows.filter(row => projectIdentity(row.url)?.id === id);
    const matchingHistory = history.filter(record => projectIdentity(record?.url)?.id === id);
    const created = result.created.find(record => record.voice123Id === id);
    const [row] = matchingRows;
    const [local] = matchingHistory;
    if (matchingRows.length !== 1 || matchingHistory.length !== 1 ||
        !row.id || row.id !== local.id || (created && row.id !== created.id) || local.voice123Id !== id ||
        row.status !== "Needs Review" || local.status !== "Needs Review" ||
        row.script !== "MANUAL_REVIEW_REQUIRED" || row.audioUrl !== "" || local.script !== null ||
        !local.attachments?.some(attachment => attachment.types.includes("XLSX")) ||
        !local.rightsFlags?.length || !isDeepStrictEqual(local.attachments, expected.attachments) ||
        !isDeepStrictEqual(local.rightsFlags, expected.rightsFlags)) {
      throw new Error(`Read-back discrepancy for ${id}: ${matchingRows.length} Sheets rows, ${matchingHistory.length} history records. Stop for reconciliation.`);
    }
    return {
      voice123Id: id, trackingId: row.id, status: row.status, script: row.script, audioUrl: row.audioUrl,
      localAttachments: local.attachments, localRightsFlags: local.rightsFlags
    };
  });
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    console.error("Persistence test failed:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { persistReviewProjects, verifyReadback, runPersistenceTest: main };
