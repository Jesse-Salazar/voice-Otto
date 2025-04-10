const { GoogleSpreadsheet } = require('google-spreadsheet');

let _sheet;

async function getSheet() {
  if (!_sheet) {
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
    await doc.useServiceAccountAuth({
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
    });
    await doc.loadInfo();
    _sheet = doc.sheetsByIndex[0];
  }
  return _sheet;
}

module.exports = {
  async addProject(data) {
    const sheet = await getSheet();
    await sheet.addRow(data);
  },

  async updateProject(projectId, updates) {
    const sheet = await getSheet();
    const rows = await sheet.getRows();
    const row = rows.find(r => r['Project ID'] === projectId);
    
    if (row) {
      Object.entries(updates).forEach(([key, value]) => {
        row[key] = value;
      });
      await row.save();
    }
  },

  async getPendingProjects() {
    const sheet = await getSheet();
    const rows = await sheet.getRows();
    return rows.filter(row => row['Status'] === 'New');
  }
};