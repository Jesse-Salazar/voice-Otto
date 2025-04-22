const { connect } = require("./browser");
const fs = require("fs-extra");
const { addProject, updateProject } = require("./googleSheets");
const { waitForElf } = require("./helpers");

// Helper functions
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Configuration
const CONFIG = {
  baseUrl: "https://voice123.com",
  selectors: {
    projectList: "ul.md-list.md-theme > li.vdl-invite-list-item",
    projectLink: "a.md-list-item-container",
    projectTitle: ".item-title",
    projectMeta: ".item-info:not(.small-icon)",
    projectDetails: {
      script: '[data-testid="project-script"]',
      description: '[data-testid="project-description"]',
      requirements: '[data-testid="project-requirements"]',
    },
  },
  navigationTimeout: 30000,
};

module.exports = {
  async checkInvites() {
    const browser = await connect();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    try {
      // --- LOGIN FLOW ---
      console.log("🌐 Navigating to login page...");
      await page.goto("https://accounts.voice123.com/signin/", {
        waitUntil: "networkidle2",
        timeout: 90000,
      });

      // Email phase
      console.log("📧 Entering email...");
      await page.waitForSelector('input[type="email"]', {
        visible: true,
        timeout: 15000,
      });
      await page.type('input[type="email"]', process.env.VOICE123_EMAIL, {
        delay: 100,
      });

      console.log("🖱️ Clicking Continue...");
      const continueButton = await page.waitForSelector(
        "body > div.mdl-layout__container > div > main > div > div > div > form > div.mdl-typography--text-right > button",
        { visible: true, timeout: 10000 }
      );
      await continueButton?.click();
      await sleep(3000);

      // Password phase
      console.log("🔑 Switching to password login...");
      const passwordOption = await page.waitForSelector(
        "body > div.mdl-layout__container > div > main > div > div > div > div > a",
        { visible: true, timeout: 10000 }
      );
      await passwordOption?.click();
      await sleep(2000);

      console.log("🔒 Entering password...");
      await page.waitForSelector('input[type="password"]', {
        visible: true,
        timeout: 15000,
      });
      await page.type('input[type="password"]', process.env.VOICE123_PASSWORD, {
        delay: 100,
      });

      console.log("🖱️ Clicking Sign In...");
      const signInButton = await page.waitForSelector(
        "body > div.mdl-layout__container > div > main > div > div > div > form > div.mdl-typography--text-right > button",
        { visible: true, timeout: 10000 }
      );
      await signInButton?.click();
      //Secong login button click
      console.log("🔄 Signed in, now logging in again...");

      // Wait for necessary elements to load
      await page.waitForSelector("button, input, a");

      // Wait for navigation triggered by clicking the button
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 5000 }), // or 'load', depending on the site
        page.evaluate(() => {
          const elements = document.querySelectorAll(
            'button, input[type="button"], input[type="submit"], a'
          );
          for (let el of elements) {
            const text = (el.textContent || el.value || "").trim();
            if (text === "Log in") {
              el.click();
              break;
            }
          }
        }),
      ]);

      console.log("🔄  Officially logged in...");

      // 2. Get list of all available projects
      const projectList = await page.$$eval(
        CONFIG.selectors.projectList,
        (items, selectors) =>
          items.map((item) => {
            const linkElement = item.querySelector(selectors.projectLink);
            const metaTexts = Array.from(
              item.querySelectorAll(selectors.projectMeta)
            ).map((el) => el.textContent.trim());

            return {
              title: item
                .querySelector(selectors.projectTitle)
                ?.textContent?.trim(),
              url: linkElement?.href,
              deadline: metaTexts.find((t) => t.includes("remaining")),
              budget: metaTexts.find(
                (t) => t.includes("Budget") || t.includes("USD")
              ),
              proposals: metaTexts.find((t) => t.includes("/")),
              type: metaTexts.find((t) => t.includes("Custom audition")),
            };
          }),
        CONFIG.selectors
      );

      if (!projectList.length) {
        console.log("⏩ No projects found in list");
        return [];
      }
      console.log(projectList);

      // 3. Process each project individually
      const processedProjects = [];

      for (const [index, project] of projectList.entries()) {
        console.log(
          `\nProcessing project ${index + 1}/${projectList.length}: ${
            project.title
          }`
        );

        // 4. Navigate to project detail page
        const projectPage = await browser.newPage();
        await projectPage.goto(project.url, {
          waitUntil: "domcontentloaded",
          timeout: CONFIG.navigationTimeout,
        });

        // 5. Extract detailed information
        const projectDetails = await projectPage.$eval(
          CONFIG.selectors.projectDetails.script,
          (el, selectors) => ({
            script: el.textContent.trim(),
            description: document
              .querySelector(selectors.description)
              ?.textContent?.trim(),
            requirements: document
              .querySelector(selectors.requirements)
              ?.textContent?.trim(),
          }),
          CONFIG.selectors.projectDetails
        );

        // 6. Combine basic and detailed info
        const fullProject = {
          ...project,
          ...projectDetails,
          status: "pending",
          processedAt: new Date().toISOString(),
        };

        // 7. Save to Google Sheets
        await addProject(fullProject);
        processedProjects.push(fullProject);

        // 8. Cleanup
        await projectPage.close();
        await waitForElf(2000); // Rate limiting
      }

      // 9. Final debug output
      await fs.writeFile(
        "projects-debug.json",
        JSON.stringify(processedProjects, null, 2)
      );

      return processedProjects;
    } catch (error) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      await page.screenshot({ path: `./errors/error-${timestamp}.png` });
      console.error("❌ Critical error:", error);
      throw error;
    } finally {
      await page.close();
    }
  },
};
