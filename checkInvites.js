/*
require('dotenv/config'); // Load environment variables

const puppeteer = require('puppeteer-core');
const { GoogleSpreadsheet } = require('google-spreadsheet');

const connectBrowser = async () => {
  return puppeteer.connect({
    browserWSEndpoint: `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_API_KEY}`
  });
};

const loginToVoice123 = async (page) => {
  await page.goto('https://accounts.voice123.com/signin');
  await page.type('#email', process.env.VOICE123_EMAIL);
  // Click the continue button
  const button = await page.waitForSelector('body > div.mdl-layout__container > div > main > div > div > div > form > div.mdl-typography--text-right > button', { visible: true, timeout: 30000 });
  console.log('Clicking the button...');
  await button.click();
  // Optional: Wait for navigation after click (if the button triggers a page change)
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 3000 });
  console.log('Button clicked successfully!');
  await page.type('#password', process.env.VOICE123_PASSWORD);
  await page.click('[data-testid="login-submit-button"]');
  await page.waitForNavigation();
};

const updateGoogleSheet = async (projects) => {
  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID);
  await doc.useServiceAccountAuth({
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
  });
  
  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0];
  await sheet.addRows(projects);
};

(async () => {
  try {
    const browser = await connectBrowser();
    const page = await browser.newPage();
    
    await loginToVoice123(page);
    
    // Scrape projects
    const projects = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.project-list-item')).map(item => ({
        id: item.dataset.projectId,
        script: item.querySelector('.project-script').innerText,
        status: 'NEW'
      }));
    });

    await updateGoogleSheet(projects.filter(p => p.status === 'NEW'));
    await browser.close();
    
  } catch (error) {
    console.error('Automation failed:', error);
    process.exit(1);
  }
})();