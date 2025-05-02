const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");
require("dotenv").config(); // Ensure .env loading
const { v4: uuidv4 } = require('uuid');
const formattedDate = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true
}).format(new Date());

// Validate critical environment variables first
const REQUIRED_ENV = [
  "GOOGLE_SHEET_ID",
  "GOOGLE_SERVICE_ACCOUNT_EMAIL",
  "GOOGLE_PRIVATE_KEY",
];

REQUIRED_ENV.forEach((variable) => {
  if (!process.env[variable]) {
    throw new Error(`Missing required environment variable: ${variable}`);
  }
});

// Configure authentication safely
const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

let _sheet;

async function getSheet() {
  if (!_sheet) {
    const doc = new GoogleSpreadsheet(
      process.env.GOOGLE_SHEET_ID,
      serviceAccountAuth
    );

    try {
      await doc.loadInfo();
      _sheet = doc.sheetsByIndex[0];
    } catch (error) {
      console.error("Failed to load Google Sheet:");
      console.error("1. Verify the Sheet ID is correct");
      console.error("2. Ensure service account has editor access");
      console.error("3. Confirm network connectivity");
      throw error;
    }
  }
  return _sheet;
}

module.exports = {
  async addProject(project) {
    const projectId = uuidv4();
    const sheet = await getSheet();
    await sheet.addRow({
      "Project ID": projectId,
      "Project Title": project.title,
      "Project URL": project.url,
      Deadline:
        project.deadline || project.meta.find((t) => t.includes("remaining")),
      //'Budget': project.budget || project.meta.find(t => t.includes('USD')),
      Script: project.script,
      Status: "New",
      "Processed At": formattedDate,
      "Client ID": project.clientId,
    });
    return projectId; //Return ID for Tracking
  },
  async updateProject(projectId, updates) {
    const sheet = await getSheet();
    const rows = await sheet.getRows();

    // Find project by ID (need to store IDs first)
    const row = rows.find((row) => row.get("Project ID") === projectId);

    if (!row) throw new Error(`Project ${projectId} not found`);

    // Update specified fields
    Object.entries(updates).forEach(([key, value]) => {
      row.set(key, value);
    });

    await row.save();
  },
};
