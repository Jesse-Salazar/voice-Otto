const { connect } = require("./browser");
const fs = require("fs-extra");
const { addProject } = require("./googleSheets");
const { waitForElf } = require("./helpers");

const CONFIG = {
  baseUrl: "https://voice123.com",
  selectors: {
    login: {
      email: 'input[type="email"]',
      password: 'input[type="password"]',
      continueBtn: 'button[type="submit"]',
      passwordLogin: '.mdl-button--accent[href="/login/"]',
      signInBtn: 'button:has-text("Continue")',
    },
    dashboard: {
      projects: "ul.md-list.md-theme > li.vdl-invite-list-item",
      projectLink: "a.md-list-item-container",
      projectTitle: ".item-title",
      projectMeta: ".item-info:not(.small-icon)",
    },
    project: {
      script:
        "div.vdl-expandable-text.field-value-text > div.content clickable",
      description: "div.read-only-extended",
      additionalDetails:
        "div.vdl-expandable-text.field-value-text > div.content clickable",
      acceptBtn:
        "#app > div:nth-child(4) > div.vdl-page.no-full-width.project-management.specs > div.md-whiteframe.md-whiteframe-1dp.vdl-banner.action-bearer.sticky.primary.md-outset.invitation-toast > div > div.md-layout.md-flex-100.button-wrapper > div:nth-child(1) > button",
    },
  },
  navigation: {
    timeout: 60000,
    waitUntil: "networkidle2",
  },
};

module.exports = {
  async checkInvites() {
    const browser = await connect();
    const mainPage = await browser.newPage();

    try {
      // --- LOGIN FLOW ---
      console.log("🌐 Starting authentication...");
      await mainPage.setViewport({ width: 1280, height: 800 });
      await mainPage.goto("https://accounts.voice123.com/signin/", {
        waitUntil: CONFIG.navigation.waitUntil,
        timeout: CONFIG.navigation.timeout,
      });

      // Handle email input
      await mainPage.waitForSelector(CONFIG.selectors.login.email, {
        visible: true,
      });
      await mainPage.type(
        CONFIG.selectors.login.email,
        process.env.VOICE123_EMAIL,
        { delay: 50 }
      );
      console.log("Typing email");
      // Click continue
      await Promise.all([
        mainPage.waitForNavigation(CONFIG.navigation),
        mainPage.click(CONFIG.selectors.login.continueBtn),
      ]);
      console.log("Switching to password login");
      // Switch to password login
      await mainPage.waitForSelector(CONFIG.selectors.login.passwordLogin, {
        visible: true,
      });
      console.log("found use password button ");
      await Promise.all([
        mainPage.waitForNavigation(CONFIG.navigation),
        mainPage.click(CONFIG.selectors.login.passwordLogin),
      ]);
      console.log("clicked type your password button");
      // Handle password input
      await mainPage.type(
        CONFIG.selectors.login.password,
        process.env.VOICE123_PASSWORD,
        { delay: 50 }
      );
      console.log("entered password information");
      await Promise.all([
        mainPage.waitForNavigation(CONFIG.navigation),
        mainPage.waitForSelector(CONFIG.selectors.login.continueBtn),
        mainPage.click(CONFIG.selectors.login.continueBtn),
      ]);

      console.log("Moving on to second login button");
      //Secong login button click

      // Wait for necessary elements to load
      await mainPage.waitForSelector("button, input, a");

      // Wait for navigation triggered by clicking the button
      await Promise.all([
        mainPage.waitForNavigation({
          waitUntil: "networkidle2",
          timeout: 5000,
        }), // or 'load', depending on the site
        mainPage.evaluate(() => {
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

      // --- PROJECT PROCESSING ---
      console.log("🔍 Scanning for projects...");
      await mainPage.waitForSelector(CONFIG.selectors.dashboard.projects, {
        timeout: 20000,
      });

      const projectList = await mainPage.$$eval(
        CONFIG.selectors.dashboard.projects,
        (items, selectors) =>
          items.map((item) => ({
            title: item
              .querySelector(selectors.projectTitle)
              ?.textContent?.trim(),
            url: item.querySelector(selectors.projectLink)?.href,
            meta: Array.from(item.querySelectorAll(selectors.projectMeta)).map(
              (el) => el.textContent.trim()
            ),
          })),
        CONFIG.selectors.dashboard
      );
      console.log(projectList);

      const processedProjects = [];

      for (const [index, project] of projectList.entries()) {
        const projectPage = await browser.newPage();

        try {
          console.log(
            `\n🚀 Processing project ${index + 1}/${projectList.length}`
          );
          await projectPage.goto(project.url, CONFIG.navigation);

          // Extract details
          const details = await projectPage.evaluate(
            (selectors) => ({
              script: document
                .querySelector(selectors.script)
                ?.textContent?.trim(),
              description: document
                .querySelector(selectors.description)
                ?.textContent?.trim(),
              additionalDetails: document
                .querySelector(selectors.additionalDetails)
                ?.textContent?.trim(),
              // requirements: document
              //   .querySelector(selectors.requirements)
              //   ?.textContent?.trim(),
            }),
            CONFIG.selectors.project
          );

          console.log(details);

          // Save to Google Sheets
          const fullProject = { ...project, ...details };
          await addProject(fullProject);
          processedProjects.push(fullProject);

          // Accept project
          const acceptButton = await projectPage.$(
            CONFIG.selectors.project.acceptBtn
          );
          if (acceptButton) {
            await Promise.all([
              projectPage.waitForNavigation(CONFIG.navigation),
              acceptButton.click(),
            ]);
            console.log("✅ Accepted project");
          }
        } catch (error) {
          console.error(`⚠️ Project error: ${error.message}`);
          await projectPage.screenshot({
            path: `errors/project-${Date.now()}.png`,
          });
        } finally {
          await projectPage.close();
          await waitForElf(2000);
        }
      }

      await fs.writeFile(
        "processed-projects.json",
        JSON.stringify(processedProjects, null, 2)
      );
      return processedProjects;
    } catch (error) {
      console.error("🚨 Critical error:", error);
      await mainPage.screenshot({
        path: `errors/main-error-${Date.now()}.png`,
      });
      throw error;
    } finally {
      await mainPage.close();
      await browser.close();
    }
  },
};
