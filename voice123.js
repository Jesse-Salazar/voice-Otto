const { connect } = require('./browser');
const { addProject } = require('./googleSheets');

// Helper functions
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

module.exports = {
  async checkInvites() {
    const browser = await connect();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    try {
      // --- LOGIN FLOW ---
      console.log('🌐 Navigating to login page...');
      await page.goto('https://accounts.voice123.com/signin/', {
        waitUntil: 'networkidle2',
        timeout: 90000
      });

      // Email phase
      console.log('📧 Entering email...');
      await page.waitForSelector('input[type="email"]', { 
        visible: true,
        timeout: 15000 
      });
      await page.type('input[type="email"]', process.env.VOICE123_EMAIL, { delay: 100 });
      
      console.log('🖱️ Clicking Continue...');
      const continueButton = await page.waitForSelector(
        'body > div.mdl-layout__container > div > main > div > div > div > form > div.mdl-typography--text-right > button',
        { visible: true, timeout: 10000 }
      );
      await continueButton?.click();
      await sleep(3000);

      // Password phase
      console.log('🔑 Switching to password login...');
      const passwordOption = await page.waitForSelector(
        'body > div.mdl-layout__container > div > main > div > div > div > div > a',
        { visible: true, timeout: 10000 }
      );
      await passwordOption?.click();
      await sleep(2000);

      console.log('🔒 Entering password...');
      await page.waitForSelector('input[type="password"]', { 
        visible: true,
        timeout: 15000 
      });
      await page.type('input[type="password"]', process.env.VOICE123_PASSWORD, { delay: 100 });
      
      console.log('🖱️ Clicking Sign In...');
      const signInButton = await page.waitForSelector('body > div.mdl-layout__container > div > main > div > div > div > form > div.mdl-typography--text-right > button',
        { visible: true, timeout: 10000 }
      );
      await signInButton?.click();
      //Secong login button click
      console.log('🔄 Signed in, now logging in again...');
      
      // Wait for necessary elements to load
  await page.waitForSelector('button, input, a');

  // Wait for navigation triggered by clicking the button
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2',timeout: 5000 }), // or 'load', depending on the site
    page.evaluate(() => {
      const elements = document.querySelectorAll('button, input[type="button"], input[type="submit"], a');
      for (let el of elements) {
        const text = (el.textContent || el.value || '').trim();
        if (text === 'Log in') {
          el.click();
          break;
        }
      }
    })
  ]);

      
      console.log('🔄  Officially logged in and looking for projects container...');

      // --- DASHBOARD SCRAPING ---
      await page.waitForSelector('#app > div.vdl-page.no-full-width.dashboard > div.page-content > section > div.vdl-data-list > ul:nth-child(7)', { 
        timeout: 5000 
      });
      await sleep(5000); // Additional buffer for loading

      console.log('🔍 Container found. Scraping projects...');
      const projects = await page.$$eval(
        '#app > div.vdl-page.no-full-width.dashboard > div.page-content > section > div.vdl-data-list > ul:nth-child(7)',
        (items) => items.map(item => {
          const getText = (selector) => 
            item.querySelector(selector)?.textContent?.trim() || null;

          const getAttribute = (selector, attr) =>
            item.querySelector(selector)?.getAttribute(attr);

          return {
            id: item.dataset.projectId || 
                getAttribute('a', 'href')?.split('/').pop() ||
                `temp-${Math.random().toString(36).substring(2, 9)}`,
            script: getText('.md-list-text-container, [data-testid="Project description"]'),
            title: getText('.field-name, [data-testid="Project name"]'),
            deadline: getText('.project-deadline, [data-testid="deadline"]'),
            canAccept: !!item.querySelector('#app > div:nth-child(4) > div.vdl-page.no-full-width.project-management.specs > div.md-whiteframe.md-whiteframe-1dp.vdl-banner.action-bearer.sticky.primary > div > div.md-layout.md-flex-100.button-wrapper > div:nth-child(1) > button, [data-testid="accept-btn"]'),
            url: getAttribute('a', 'href')
          };
        })
      );
      console.log(projects);
      // Process new projects
      const acceptableProjects = projects.filter(p => p.canAccept);
      console.log(`✅ Found ${acceptableProjects.length} acceptable projects`);

      for (const project of acceptableProjects) {
        await addProject({
          'Project ID': project.id,
          'Script Text': project.script,
          'Status': 'New',
          'Title': project.title,
          'Deadline': project.deadline,
          'URL': project.url
        });
        console.log(acceptableProjects);
      }

      return acceptableProjects;

    } catch (error) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      await page.screenshot({ path: `./errors/error-${timestamp}.png` });
      console.error('❌ Error in checkInvites:', error);
      throw error;
    } finally {
      await browser.close();
    }
  }
};
