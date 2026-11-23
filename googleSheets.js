const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
require("dotenv").config();
const { v4: uuidv4 } = require("uuid");
const { projectIdentity } = require("./voice123-projects");
const formattedDate = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
}).format(new Date());

// Validate critical environment variables first
const REQUIRED_ENV = [
  "GOOGLE_SHEET_ID",
  "GOOGLE_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_PRIVATE_KEY",
];

const VALID_STATUSES = [
  "new",
  "Processing",
  "Pending Approval",
  "Approved",
  "Rejected",
  "Uploaded",
  "Upload Failed",
  "Error",
  "Needs Review", "Project Reviewed", "Generation Approved", "Pending Submission Approval",
  "Submission Approved", "Submission Uncertain"
];

REQUIRED_ENV.forEach((variable) => {
  if (!process.env[variable]) {
    throw new Error(`Missing required environment variable: ${variable}`);
  }
});

// Configure authentication safely
const { retry } = require("./helpers");

const sheets = new Map();

async function getSheet(readOnly = false) {
  if (!sheets.has(readOnly)) {
    const auth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      scopes: [`https://www.googleapis.com/auth/spreadsheets${readOnly ? ".readonly" : ""}`],
    });
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
    await retry(() => doc.loadInfo(), {
      retries: 4,
      delayMs: 1500,
      backoffFactor: 2,
      context: "googleSheets.loadInfo",
    });
    sheets.set(readOnly, doc.sheetsByIndex[0]);
  }
  return sheets.get(readOnly);
}

function projectRow(project, id) {
  return {
    "Project ID": id,
    "Project Title": project.title,
    "Project URL": project.url,
    Deadline: project.deadline || project.meta?.find(value => value.includes("remaining")) || "No deadline found",
    Script: project.script || "MANUAL_REVIEW_REQUIRED",
    Status: project.status,
    "Processed At": formattedDate,
    "Client ID": project.clientId,
    "Audio File URL": "",
  };
}

module.exports = {
  async addProject(project, trackingId) {
    if (!VALID_STATUSES.includes(project.status)) {
      throw new Error(`Invalid status: ${project.status}`);
    }

    if (typeof trackingId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(trackingId)) throw new Error("Explicit tracking ID required");
    const projectId = trackingId;
    const sheet = await getSheet();
    const rows = await sheet.getRows();
    if (rows.some(row => row.get("Project ID") === trackingId ||
        projectIdentity(row.get("Project URL"))?.id === project.voice123Id)) {
      throw new Error("Project or tracking ID already exists");
    }

    await sheet.addRow(projectRow(project, projectId), { raw: true, insert: true });
    return projectId; //Return ID for Tracking
  },
  async getProjectHeaders() {
    const sheet = await getSheet(true);
    await sheet.loadHeaderRow();
    return [...sheet.headerValues];
  },
  async getApprovalProject({ id, voice123Id }) {
    const sheet = await getSheet(true);
    const rows = await sheet.getRows();
    for (const header of ["Reviewed At", "Uploaded At", "Notes", "Approval Evidence"]) {
      if (!sheet.headerValues.includes(header)) throw new Error(`Missing approval column: ${header}`);
    }
    const matching = rows.filter(row => (id && row.get("Project ID") === id) ||
      (voice123Id && projectIdentity(row.get("Project URL"))?.id === voice123Id));
    if (matching.length !== 1) throw new Error("Missing or conflicting project approval records");
    const [row] = matching;
    const url = row.get("Project URL");
    const project = projectIdentity(url);
    if (!project || (id && row.get("Project ID") !== id) || (voice123Id && project.id !== voice123Id) ||
        rows.filter(item => projectIdentity(item.get("Project URL"))?.id === project.id ||
          item.get("Project ID") === row.get("Project ID")).length !== 1) {
      throw new Error("Missing or conflicting project approval records");
    }
    return {
      id: row.get("Project ID"), url, status: row.get("Status"), script: row.get("Script"),
      evidence: row.get("Approval Evidence"), audioUrl: row.get("Audio File URL"),
      voiceSettings: row.get("Voice Settings"), notes: row.get("Notes")
    };
  },
  async appendReviewProjects(projects) {
    const ids = new Set();
    for (const project of projects) {
      const identity = projectIdentity(project.url);
      if (project.status !== "Needs Review" || project.script !== null ||
          project.invitationStatus !== "New invitation" || !identity ||
          identity.id !== project.voice123Id || ids.has(identity.id)) {
        throw new Error("Invalid or duplicate persistence-test project");
      }
      ids.add(identity.id);
    }
    if (!projects.length) return [];

    const sheet = await getSheet();
    const existingRows = await sheet.getRows();
    const missingHeaders = Object.keys(projectRow(projects[0], "")).filter(header => !sheet.headerValues.includes(header));
    if (missingHeaders.length) throw new Error(`Missing Sheets columns: ${missingHeaders.join(", ")}`);
    const existing = new Set(existingRows.map(row => projectIdentity(row.get("Project URL"))?.id));
    const assigned = new Set(existingRows.map(row => row.get("Project ID")));
    const additions = projects.filter(project => !existing.has(project.voice123Id)).map(project => {
      let id;
      do { id = uuidv4().substring(0, 8); } while (assigned.has(id));
      assigned.add(id);
      return { ...project, id };
    });
    if (additions.length) {
      await sheet.addRows(additions.map(project => projectRow(project, project.id)), { raw: true, insert: true });
    }
    return additions;
  },
  async updateProject(projectId, updates, expected) {
    if (updates.Status && !VALID_STATUSES.includes(updates.Status)) {
      throw new Error(`Invalid status: ${updates.Status}`);
    }
    const sheet = await getSheet();
    const rows = await sheet.getRows();

    // Find project by ID (need to store IDs first)
    const matches = rows.filter(row => row.get("Project ID") === projectId);
    if (matches.length !== 1) throw new Error("Missing or conflicting tracking ID");
    const [row] = matches;
    const fields = Object.entries(updates).map(([key, value]) => {
      const index = sheet.headerValues.indexOf(key);
      if (index < 0) throw new Error(`Missing Sheets column: ${key}`);
      return { index, value };
    });
    if (!fields.length) return;
    const rowIndex = row.rowNumber - 1;
    const idIndex = sheet.headerValues.indexOf("Project ID");
    await sheet.loadCells({
      startRowIndex: rowIndex, endRowIndex: rowIndex + 1,
      startColumnIndex: 0, endColumnIndex: sheet.headerValues.length
    });
    if (sheet.getCell(rowIndex, idIndex).value !== projectId) throw new Error("Project row moved before update");
    if (expected) {
      const snapshot = {
        "Project URL": expected.url, Status: expected.status, Script: expected.script,
        "Approval Evidence": expected.evidence, "Audio File URL": expected.audioUrl,
        "Voice Settings": expected.voiceSettings, Notes: expected.notes
      };
      for (const [header, value] of Object.entries(snapshot)) {
        const index = sheet.headerValues.indexOf(header);
        if (index < 0 || String(sheet.getCell(rowIndex, index).value ?? "") !== String(value ?? "")) {
          throw new Error("Project or approval changed before update");
        }
      }
    }
    const cells = fields.flatMap(({ index, value }) => {
      const cell = sheet.getCell(rowIndex, index);
      if (cell.value === value || ((cell.value == null || cell.value === "") && value === "")) return [];
      cell.value = value;
      return [cell];
    });
    if (cells.length) await sheet.saveCells(cells);
  },
  async getProjectRecords({ readOnly = false } = {}) {
    const sheet = await getSheet(readOnly);
    const rows = await sheet.getRows();
    return rows.map(row => ({
      url: row.get("Project URL"),
      id: row.get("Project ID"),
      status: row.get("Status"),
      script: row.get("Script"),
      audioUrl: row.get("Audio File URL") || ""
    }));
  },
  async getProjectsByStatus(status) {
    const sheet = await getSheet();
    const rows = await sheet.getRows();

    return rows
      .filter((row) => row.get("Status") === status)
      .map((row) => ({
        id: row.get("Project ID"),
        title: row.get("Project Title"),
        url: row.get("Project URL"),
        status: row.get("Status"),
        audioFileName: (row.get("Audio File URL") || "").split("/").pop(),
        audioUrl: row.get("Audio File URL"),
        reviewedAt: row.get("Reviewed At"),
      }));
  },
};
