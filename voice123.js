const { connect } = require("./browser");
const fs = require("fs-extra");
const { addProject } = require("./googleSheets");
const { log, retry, waitFor, safeQuerySelector } = require("./helpers");
const { v4: uuidv4 } = require("uuid");

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
      script: validateSelector(process.env.SCRIPT_SELECTOR, "script"),
      description: validateSelector(
        process.env.DESCRIPTION_SELECTOR,
        "description"
      ),
      requirements: validateSelector(
        process.env.REQUIREMENTS_SELECTOR,
        "requirements"
      ),
      acceptBtn: validateSelector(
        process.env.ACCEPT_BTN_SELECTOR,
        "accept button"
      ),
      clientId: validateSelector(process.env.CLIENT_SELECTOR, "clientId"),
    },
  },
  navigation: {
    timeout: 10000,
    waitUntil: "networkidle2",
  },
};

// Utility function to check for invalid or missing selectors
function validateSelector(selector, context = "general") {
  if (!selector || typeof selector !== "string" || selector.trim() === "") {
    throw new Error(`Invalid selector in ${context}: ${selector}`);
  }
  return selector;
}

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
      console.log("💬 Entering email...");
      // Click continue
      await Promise.all([
        mainPage.waitForNavigation(CONFIG.navigation),
        mainPage.click(CONFIG.selectors.login.continueBtn),
      ]);
      console.log("🔁 Switching to password login...");
      // Switch to password login
      await mainPage.waitForSelector(CONFIG.selectors.login.passwordLogin, {
        visible: true,
      });
      console.log("🧐 Found use password button");
      await Promise.all([
        mainPage.waitForNavigation(CONFIG.navigation),
        mainPage.click(CONFIG.selectors.login.passwordLogin),
      ]);
      console.log("✅ Clicked type your password button");
      // Handle password input
      await mainPage.type(
        CONFIG.selectors.login.password,
        process.env.VOICE123_PASSWORD,
        { delay: 50 }
      );
      console.log("🔐 Entered password information");
      await Promise.all([
        mainPage.waitForNavigation(CONFIG.navigation),
        mainPage.waitForSelector(CONFIG.selectors.login.continueBtn),
        mainPage.click(CONFIG.selectors.login.continueBtn),
      ]);

      console.log("🚚 Moving on to second login button...");
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

      console.log("🪪 Officially logged in");

      // --- PROJECT PROCESSING ---
      console.log("🔍 Scanning for projects...");
      try {
        await mainPage.waitForSelector(CONFIG.selectors.dashboard.projects, {
          timeout: 10000,
        });
      } catch (error) {
        if (error.name === "TimeoutError") {
          // Verify if projects are actually missing
          const projectsExist = await mainPage.$(
            CONFIG.selectors.dashboard.projects
          );
          if (!projectsExist) {
            console.log("🚫 No available projects found");
            return []; // Return empty array instead of error
          }
        }
        throw error; // Re-throw other errors
      }

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

      const processedProjects = [];

      for (const [index, project] of projectList.entries()) {
        const projectPage = await browser.newPage();

        try {
          console.log(
            `\n🚀 Processing project ${index + 1}/${projectList.length}`
          );
          await projectPage.goto(project.url, CONFIG.navigation);

          // Extract details
          const details = {
            script: await safeQuerySelector(
              projectPage,
              CONFIG.selectors.project.script
            ),
            description: await safeQuerySelector(
              projectPage,
              CONFIG.selectors.project.description
            ),
            //requirements: await safeQuerySelector(projectPage, CONFIG.selectors.project.requirements),
            clientId: await safeQuerySelector(
              projectPage,
              CONFIG.selectors.project.clientId
            ),
          };

          // Save to Google Sheets
          const fullProject = {
            id: uuidv4(),
            title: project.title,
            url: project.url,

            // Safely handle meta data
            deadline:
              project.deadline ||
              (project.meta || []).find((t) => t.includes?.("remaining")) ||
              "No deadline found",

            // budget: project.budget || (project.meta || []).find(t => t.includes?.('USD')) || 'Budget not specified',

            // Safely handle nested details
            script: project.script || details?.script || "No script available",
            description: details?.description || "No description",
            //requirements: details?.requirements || 'No requirements',
            clientId: details?.clientId || "No client ID",
          };

          const projectId = await addProject(fullProject);
          processedProjects.push({ ...fullProject, id: projectId });

          // Accept project
          // const acceptButton = await projectPage.$(
          //   CONFIG.selectors.project.acceptBtn
          // );
          // if (acceptButton) {
          //   await Promise.all([
          //     projectPage.waitForNavigation(CONFIG.navigation),
          //     acceptButton.click(),
          //   ]);
          //   console.log("✅ Accepted project");
          // }
        } catch (error) {
          console.error(`⚠️ Project error: ${error.message}`);
          await projectPage.screenshot({
            path: `errors/project-${Date.now()}.png`,
          });
        } finally {
          await projectPage.close();
          await waitFor(2000);
        }
      }

      await fs.writeFile(
        "processed-projects.json",
        JSON.stringify(processedProjects, null, 2)
      );
      return processedProjects;
    } catch (error) {
      if (error.name === 'TimeoutError' && error.message.includes(CONFIG.selectors.dashboard.projects)) {
        console.log("🟡 No active projects available");
        return []; // Return empty array instead of crashing
      }
      console.error("🚨 Critical error:", error);
      await mainPage.screenshot({ path: `errors/main-error-${Date.now()}.png` });
      throw error;
    } finally {
      await mainPage.close();
      await browser.close();
    }
  }
};
