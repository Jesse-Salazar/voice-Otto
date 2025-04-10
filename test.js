const puppeteer = require('puppeteer-core');
const fs = require('fs');

// Detect the Chrome/Chromium path
const chromePaths = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/opt/homebrew/bin/chromium',
  '/usr/local/bin/chromium'
];

const findBrowserPath = () => {
  for (const path of chromePaths) {
    if (fs.existsSync(path)) {
      return path;
    }
  }
  throw new Error('No Chrome or Chromium executable found.');
};

(async () => {
  const executablePath = findBrowserPath();
  console.log(`Using browser: ${executablePath}`);

  const browser = await puppeteer.launch({
    headless: false,
    executablePath,
    args: ['--disable-extensions', '--disable-sync']
  });

  const page = await browser.newPage();

  await page.goto('https://accounts.voice123.com/signin/', {
    waitUntil: 'networkidle2'
  });

  // Use XPath to find the "Continue" button
  const elements = await page.$x("//button[contains(text(), 'Continue')]");
  const continueBtn = elements[0];

  if (continueBtn) {
    console.log('Clicking the "Continue" button...');
    await continueBtn.click();
  } else {
    console.log('No "Continue" button found.');
  }

  await page.waitForTimeout(3000);
  await browser.close();
})();
