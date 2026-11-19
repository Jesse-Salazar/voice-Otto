const puppeteerCore = require('puppeteer-core');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

module.exports.connect = async () => {
  const chromeArgs = [
    '--disable-features=site-per-process',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-crash-reporter',
    '--disable-breakpad'
  ];

  // Default to launching a local Chromium. To use the remote browserless
  // endpoint set `USE_BROWSERLESS=true` and provide `BROWSERLESS_API_KEY`.
  const useBrowserless = String(process.env.USE_BROWSERLESS || '').toLowerCase() === 'true';
  let browser;
  if (useBrowserless) {
    if (!process.env.BROWSERLESS_API_KEY) {
      throw new Error('BROWSERLESS_API_KEY is required when USE_BROWSERLESS=true');
    }
    browser = await puppeteerCore.connect({
      browserWSEndpoint: `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_API_KEY}&launch=${encodeURIComponent(chromeArgs.join(' '))}`
    });
  } else {
    const userDataDir = process.env.CHROME_USER_DATA_DIR ||
      path.join(process.cwd(), '.chrome-user-data');
    fs.mkdirSync(userDataDir, { recursive: true });

    browser = await puppeteer.launch({
      headless: process.env.HEADLESS === 'false' ? false : true,
      args: chromeArgs,
      userDataDir
    });
  }

  // Monkey-patch browser.newPage so every page has a more realistic UA/headers
  // and a small 'stealth' injection to reduce automated-browser detections.
  const origNewPage = browser.newPage.bind(browser);
  browser.newPage = async (...args) => {
    const page = await origNewPage(...args);

    // Use an env override or a sensible default modern UA for macOS Chrome
    const userAgent = process.env.USER_AGENT ||
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    await page.setUserAgent(userAgent);

    // Helpful headers (accept-language often checked by WAFs)
    await page.setExtraHTTPHeaders({ 'accept-language': process.env.ACCEPT_LANGUAGE || 'en-US,en;q=0.9' });

    // Default viewport similar to a real user
    await page.setViewport({ width: 1280, height: 800 });

    // Inject small stealth hints before any page scripts run
    await page.evaluateOnNewDocument(() => {
      try {
        // navigator.webdriver -> false
        Object.defineProperty(navigator, 'webdriver', { get: () => false });

        // Provide a minimal chrome runtime object
        window.navigator.chrome = window.navigator.chrome || { runtime: {} };

        // Languages
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

        // Plugins (non-empty length)
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      } catch (e) {
        // ignore injection errors
      }
    });

    return page;
  };

  return browser;
};
