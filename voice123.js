const path = require("path");
const { connect } = require("./browser");
const fs = require("fs-extra");
const { addProject } = require("./googleSheets");
const { log, retry, waitFor, safeQuerySelector } = require("./helpers");

const CONFIG = {
  baseUrl: "https://voice123.com",
  selectors: {
    login: {
      email: 'input[type="email"]',
      password: 'input[type="password"]',
      continueBtn: 'button[type="submit"]',
      passwordLogin: '.mdl-button--accent[href="/login/"]',
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
      hasAttachment: validateSelector(
        process.env.ATTACHMENT_SELECTOR,
        "hasAttachment"
      ),
      // New upload selectors
      upload: {
        fileInput: validateSelector(
          process.env.FILE_INPUT_SELECTOR,
          "file input"
        ),
        submitButton: validateSelector(
          process.env.SUBMIT_BUTTON_SELECTOR,
          "submit button"
        ),
        successIndicator: validateSelector(
          process.env.UPLOAD_SUCCESS_SELECTOR,
          "upload success"
        ),
      },
    },
  },
  navigation: {
    timeout: 15000,
    waitUntil: "domcontentloaded",
  },
  uploadRetries: 3,
};

// Utility function to check for invalid or missing selectors
function validateSelector(selector, context = "general") {
  if (!selector || typeof selector !== "string" || selector.trim() === "") {
    throw new Error(`Invalid selector in ${context}: ${selector}`);
  }
  return selector;
}

async function handleLogin(page) {
  console.log("🌐 Starting authentication...");
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto("https://accounts.voice123.com/signin/", {
    waitUntil: CONFIG.navigation.waitUntil,
    timeout: CONFIG.navigation.timeout,
  });
  await page.waitForSelector(CONFIG.selectors.login.email, { visible: true });
  await page.type(CONFIG.selectors.login.email, process.env.VOICE123_EMAIL, {
    delay: 50,
  });

  console.log("💬 Entering email...");
  // Click continue
  await Promise.all([
    page.waitForNavigation(CONFIG.navigation),
    page.click(CONFIG.selectors.login.continueBtn),
  ]);
  console.log("🔁 Switching to password login...");
  // Switch to password login
  await page.waitForSelector(CONFIG.selectors.login.passwordLogin, {
    visible: true,
  });
  console.log("🧐 Found use password button");
  await Promise.all([
    page.waitForNavigation(CONFIG.navigation),
    page.click(CONFIG.selectors.login.passwordLogin),
  ]);
  console.log("✅ Clicked type your password button");
  // Handle password input
  await page.type(
    CONFIG.selectors.login.password,
    process.env.VOICE123_PASSWORD,
    { delay: 50 }
  );
  console.log("🔐 Entered password information");
  await Promise.all([
    page.waitForNavigation(CONFIG.navigation),
    page.waitForSelector(CONFIG.selectors.login.continueBtn),
    page.click(CONFIG.selectors.login.continueBtn),
  ]);

  console.log("🚚 Moving on to second login button...");
  //Secong login button click

  // Wait for necessary elements to load
  await page.waitForSelector("button, input, a");

  // Wait for navigation triggered by clicking the button
  await Promise.all([
    page.waitForNavigation({
      waitUntil: "networkidle2",
      timeout: 5000,
    }), // or 'load', depending on the site
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
  console.log("🔑 Verified login success");
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

      console.log("🪪  Officially logged in");

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
        throw error;
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

            clientId: await safeQuerySelector(
              projectPage,
              CONFIG.selectors.project.clientId
            ),
            hasAttachment: await projectPage
              .$(CONFIG.selectors.project.hasAttachment)
              .catch(() => false),
          };

          // --- ENHANCED VALIDATION ---
          const MIN_SCRIPT_LENGTH = 50; // Minimum characters to consider valid

          // Save to Google Sheets
          const fullProject = {
            title: project.title,
            url: project.url,

            // Safely handle meta data
            deadline:
              project.deadline ||
              (project.meta || []).find((t) => t.includes?.("remaining")) ||
              "No deadline found",

            // Safely handle nested details
            script: null,
            description: details?.description || "No description",
            clientId: details?.clientId || "No client ID",
            status: "new",
          };

          // --- VALIDATE SCRIPT ---
          if (details.hasAttachment) {
            console.log("⏩ Project has attachments - requires manual review");
            fullProject.status = "needs_manual_review";
          } else if (
            !details.script ||
            details.script.length < MIN_SCRIPT_LENGTH
          ) {
            console.log(
              "🔍 Script too short or missing - manual review needed"
            );
            fullProject.status = "needs_manual_review";
          } else {
            fullProject.status = "Processing";
            fullProject.script = details.script;
          }

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
      if (
        error.name === "TimeoutError" &&
        error.message.includes(CONFIG.selectors.dashboard.projects)
      ) {
        console.log("🟡 No active projects available");
        return []; // Return empty array instead of crashing
      }
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
  // Add new upload function
  async uploadAudio(projectUrl, audioPath) {
    if (!audioPath || typeof audioPath !== "string") {
      throw new Error("Invalid audio path");
    }

    // Resolve absolute path
    const absolutePath = path.resolve(audioPath);
    console.log("📂 Audio file path:", absolutePath);

    // Verify file exists
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Audio file not found: ${absolutePath}`);
    }

    const browser = await connect();
    const page = await browser.newPage();

    try {
      // Reuse existing login functionality
      await handleLogin(page);

      console.log(`🌐 Navigating to project page: ${projectUrl}`);
      await page.goto(projectUrl, {
        waitUntil: "load",
        timeout: 30000,
      });
      // Verify we're on project details page
      await page.waitForSelector(".upload-box", {
        visible: true,
        timeout: 15000,
      });

      // // Accept project first
      // await retry(
      //   async () => {
      //     // Wait for button to be actionable
      //     await page.waitForSelector(CONFIG.selectors.project.acceptBtn, {
      //       visible: true,
      //       timeout: 10000,
      //     });

      //     // Scroll into view and click
      //     await page.$eval(CONFIG.selectors.project.acceptBtn, (button) => {
      //       button.scrollIntoView({ behavior: "smooth", block: "center" });
      //     });

      //     await page.click(CONFIG.selectors.project.acceptBtn);

      //     // Wait for page state update
      //     await page.waitForNavigation({
      //       waitUntil: "networkidle0",
      //       timeout: 15000,
      //     });

      //     console.log("✅ Accepted project invitation");
      //   },
      //   {
      //     retries: 5,
      //     delay: 3000,
      //   }
      // );
      // After clicking accept button

      // Handle file upload
      // Verify absolute path exists
      const absoluteAudioPath = path.resolve(process.cwd(), audioPath);
      if (!fs.existsSync(absoluteAudioPath)) {
        throw new Error(`Audio file not found: ${absoluteAudioPath}`);
      }

      // Enhanced file input handling
      await retry(
        async () => {
          console.log("🔍 Locating file input...");

          // Wait for input to be interactable
          const fileInput = await page.waitForSelector(
            CONFIG.selectors.project.upload.fileInput,
            {
              visible: true,
              timeout: 15000,
              state: "attached", // Ensure element is in DOM
            }
          );

          // Scroll into view and hover
          await fileInput.scrollIntoView();
          await fileInput.hover();
          await new Promise(resolve => setTimeout(resolve, 1000));

          console.log("📁 Clicking file input...");
          const [fileChooser] = await Promise.all([
            page.waitForFileChooser({ timeout: 15000 }),
            fileInput.click({ clickCount: 1, delay: 200 }),
          ]);

          console.log("⬆️ Selecting audio file...");
          await fileChooser.accept([absoluteAudioPath]);
        },
        {
          retries: 5,
          delay: 3000,
        }
      );

      // Submit the form
      await retry(async () => {
        await page.waitForSelector(
          CONFIG.selectors.project.upload.submitButton,
          {
            visible: true,
            timeout: 5000,
          }
        );
        await page.click(CONFIG.selectors.project.upload.submitButton);
        console.log("🚀 Submitted upload form");
      }, CONFIG.uploadRetries);

      // Verify successful upload
      await page.waitForSelector(
        CONFIG.selectors.project.upload.successIndicator,
        {
          visible: true,
          timeout: 15000,
        }
      );
      console.log("🎉 Successfully uploaded audio");

      return true;
    } catch (error) {
      console.error("🚨 Upload failed:", error.message);
      await page.screenshot({
        path: `errors/upload-error-${Date.now()}.png`,
      });
      return false;
    } finally {
      await page.close();
      await browser.close();
    }
  },
};
