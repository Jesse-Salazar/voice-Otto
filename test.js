const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
require('dotenv').config();

async function verifyAccess() {
  // Verify environment variables
  console.log('Service Account Email:', process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
  console.log('Sheet ID:', process.env.GOOGLE_SHEET_ID);
  console.log('Private Key Start:', process.env.GOOGLE_PRIVATE_KEY?.slice(0, 35));

  // Initialize auth
  const auth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  // Test connection
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
  
  try {
    await doc.loadInfo();
    console.log('\n✅ Success! Connected to spreadsheet:', doc.title);
    console.log('📑 First sheet title:', doc.sheetsByIndex[0].title);
  } catch (error) {
    console.log('\n❌ Failed to access spreadsheet:');
    console.log('1. Confirm the service account email has EDIT access to the sheet');
    console.log('2. Verify Sheet ID matches URL exactly');
    console.log('3. Ensure Google Sheets API is enabled');
    throw error;
  }
}

verifyAccess().catch(console.error);