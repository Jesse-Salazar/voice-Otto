/*
require('dotenv/config');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const getSheet = async () => {
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
  
  await doc.useServiceAccountAuth({
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
  });

  await doc.loadInfo();
  return doc.sheetsByIndex[0]; // First worksheet
};

// Add new projects
const addProjects = async (projects) => {
  const sheet = await getSheet();
  await sheet.addRows(projects);
};

// Update project status
const updateProject = async (projectId, updates) => {
  const sheet = await getSheet();
  const rows = await sheet.getRows();
  
  const targetRow = rows.find(row => row['Project ID'] === projectId);
  if (!targetRow) throw new Error('Project not found');
  
  Object.entries(updates).forEach(([key, value]) => {
    targetRow[key] = value;
  });
  
  await targetRow.save();
};

module.exports = { addProjects, updateProject };