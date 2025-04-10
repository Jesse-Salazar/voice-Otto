/*
require('dotenv').config(); // Load environment variables

const puppeteer = require('puppeteer-core');
const fs = require('fs');

const BROWSERLESS_WS_ENDPOINT = `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_TOKEN}`;
const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;

// Sleep helper
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const browser = await puppeteer.connect({
    browserWSEndpoint: BROWSERLESS_WS_ENDPOINT
  });

  const page = await browser.newPage();
  await page.goto('https://voice123.com/', { waitUntil: 'networkidle2' });

  // DEBUG: Save a screenshot of the homepage
  await page.screenshot({ path: 'debug-homepage.png' });

  // Find and click the "Log in" link using querySelector
  const loginLinkHandle = await page.evaluateHandle(() => {
    const links = Array.from(document.querySelectorAll('a'));
    return links.find(link =>
      link.textContent.toLowerCase().includes('log in') ||
      link.textContent.toLowerCase().includes('login')
    );
  });

  if (!loginLinkHandle) {
    console.error('❌ Login link not found.');
    await browser.close();
    return;
  }

  await page.evaluate(el => el.scrollIntoView(), loginLinkHandle);
  await sleep(500);
  await loginLinkHandle.click();

  await sleep(1000); // Wait for login screen

  // Type email and continue
  await page.waitForSelector('input[type="email"]');
  await page.type('input[type="email"]', EMAIL);

  // Find and click the "continue" link using querySelector
  const continueLinkHandle = await page.evaluateHandle(() => {
    const allLinks = Array.from(document.querySelectorAll('a'));
    return allLinks.find(link =>
      link.textContent.toLowerCase().includes('Continue') ||
      link.textContent.toLowerCase().includes('continue')
    );
  });

  if (!continueLinkHandle) {
    console.error('❌ continue link not found.');
    await browser.close();
    return;
  }

  //await page.evaluate(el => el.scrollIntoView(), continueLinkHandle);
  await sleep(500);
  await continueLinkHandle.click();

  await sleep(1000);

  // Click "Type your password"
  const buttons = await page.$$('button');
  for (const btn of buttons) {
    const text = await page.evaluate(el => el.innerText, btn);
    if (text.toLowerCase().includes('type your password')) {
      await page.evaluate(el => el.scrollIntoView(), btn);
      await sleep(300);
      await btn.click();
      break;
    }
  }

  await sleep(1000);

  // Type password and log in
  await page.waitForSelector('input[type="password"]');
  await page.type('input[type="password"]', PASSWORD);
  const loginBtn = await page.$('button[type="submit"]');
  await page.evaluate(el => el.scrollIntoView(), loginBtn);
  await loginBtn.click();

  await page.waitForNavigation({ waitUntil: 'networkidle2' });

  // Navigate to invites page
  await page.goto('https://voice123.com/dashboard/invites', { waitUntil: 'networkidle2' });
  await sleep(2000);
  await page.waitForSelector('a[href^="/projects/"]');

  const projects = await page.$$eval('a[href^="/projects/"]', links =>
    links.map(link => ({
      title: link.innerText.trim(),
      url: link.href
    }))
  );

  console.log(`📥 Found ${projects.length} invites.`);

  const results = [];

  for (const project of projects) {
    await page.goto(project.url, { waitUntil: 'networkidle2' });

    try {
      await page.waitForSelector('button', { timeout: 5000 });

      // Accept Invite button using evaluate
      const acceptBtnHandle = await page.evaluateHandle(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.find(btn => btn.innerText.includes('Accept Invite'));
      });

      if (acceptBtnHandle) {
        await page.evaluate(el => el.scrollIntoView(), acceptBtnHandle);
        await sleep(300);
        await acceptBtnHandle.click();
        await sleep(2000);
      }

      // Extract script from audition section
      const scriptText = await page.$eval(
        '.audition-script pre, .audition-script textarea',
        el => el.innerText || el.value
      );

      results.push({
        title: project.title,
        url: project.url,
        script: scriptText.trim()
      });

      console.log(`✅ Scraped: ${project.title}`);

    } catch (err) {
      console.warn(`⚠️ Skipped: ${project.title} (error: ${err.message})`);
    }
  }

  // Save to local JSON
  fs.writeFileSync('voice123-invites.json', JSON.stringify(results, null, 2), 'utf-8');
  console.log('\n💾 Saved to voice123-invites.json');

  await browser.close();
})();
