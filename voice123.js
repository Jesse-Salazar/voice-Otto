const path = require("path");
const { connect } = require("./browser");
const fs = require("fs-extra");
const { addProject } = require("./googleSheets");
const { waitFor, safeQuerySelector, saveArtifacts, ensureBudgetFields } = require("./helpers");
const { spawnSync } = require('child_process');

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
      projects: "li.vdl-invite-list-item a.md-list-item-container",
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
        failureIndicator: validateSelector(
          process.env.ERROR_MESSAGE_SELECTOR,
          "upload fail"
        ),
    // Budget-related selectors (optional: set via env vars)
    budgetLabel: process.env.BUDGET_LABEL_SELECTOR || '.budget-label',
    priceQuote: process.env.PRICE_QUOTE_SELECTOR || 'input[name="price_quote" ]',
    additionalProposal: process.env.ADDITIONAL_PROPOSAL_SELECTOR || 'textarea[name="proposal_details"]'
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

  // console.log("🚚 Moving on to second login button...");
  // //Secong login button click

  // // Wait for necessary elements to load
  // await page.waitForSelector("button, input, a");

  // // Wait for navigation triggered by clicking the button
  // await Promise.all([
  //   page.waitForNavigation({
  //     waitUntil: "networkidle2",
  //     timeout: 5000,
  //   }), // or 'load', depending on the site
  //   page.evaluate(() => {
  //     const elements = document.querySelectorAll(
  //       'button, input[type="button"], input[type="submit"], a'
  //     );
  //     for (let el of elements) {
  //       const text = (el.textContent || el.value || "").trim();
  //       if (text === "Log in") {
  //         el.click();
  //         break;
  //       }
  //     }
  //   }),
  // ]);
  console.log("🔑 Verified login success");
}

function validateAudioFile(filePath) {
  const validExtensions = [".mp3", ".wav"];
  const ext = path.extname(filePath).toLowerCase();

  if (!validExtensions.includes(ext)) {
    throw new Error(`Invalid file type: ${ext}. Only MP3/WAV allowed`);
  }

  const stats = fs.statSync(filePath);
  if (stats.size > 100 * 1024 * 1024) {
    throw new Error("File exceeds 100MB limit");
  }

  // Add additional validation as needed
  return true;
}

// Attempt to transcode audio to a site-friendly MP3 (44.1kHz, mono, 128kbps).
// Returns the path to the transcoded file, or null if transcoding was skipped/failed.
async function transcodeAudio(inputPath, preferredFormats) {
  try {
    // Check ffmpeg existence
    const which = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
    if (which.error || which.status !== 0) {
      console.log('ffmpeg not available in PATH; skipping transcoding');
      return null;
    }

    // Ensure tmp_audio dir exists
    const tmpDir = path.resolve(__dirname, 'tmp_audio');
    fs.ensureDirSync(tmpDir);

    // Try mp3 first (site accepts WAV with 44.1kHz, 16-bit PCM, mono and asks
    // for max peak around -3dB). Use a conservative, explicit -3dB gain rather
    // than loudnorm which can add complexity. Fall back to MP3 with a simple
    // -3dB attenuation if needed.
    const tryFormats =
      preferredFormats || [
      {
        ext: 'mp3',
        args: [
          '-ar', '44100',
          '-ac', '1',
          '-codec:a', 'libmp3lame',
          '-b:a', '128k',
          '-af', 'volume=-3dB'
        ]
      },
            {
        ext: 'wav',
        args: [
          '-ar', '44100',
          '-ac', '1',
          '-c:a', 'pcm_s16le',
          '-af', 'volume=-3dB'
        ]
      }
    ];

    for (const fmt of tryFormats) {
      const outName = `transcoded-${Date.now()}.${fmt.ext}`;
      const outPath = path.join(tmpDir, outName);
      const args = ['-y', '-i', inputPath, ...fmt.args, outPath];

      console.log(`Running ffmpeg to transcode to ${fmt.ext}:`, args.join(' '));
      const res = spawnSync('ffmpeg', args, { stdio: 'inherit' });
      if (res.error || res.status !== 0) {
        console.warn(`ffmpeg failed to produce ${fmt.ext}; trying next format if available`);
        // remove any partial file
        try { if (fs.existsSync(outPath)) fs.removeSync(outPath); } catch (e) {}
        continue;
      }

      // Verify output exists and is not empty
      if (fs.existsSync(outPath)) {
        const stats = fs.statSync(outPath);
        if (stats.size > 0) {
          console.log(`Transcoding complete: ${outPath}`);
          return outPath;
        }
      }
    }

    return null;
  } catch (e) {
    console.warn('Transcoding error:', e.message);
    return null;
  }
}

module.exports = {
  async checkInvites() {
    const browser = await connect();
    const page = await browser.newPage();

    try {
      // --- LOGIN FLOW ---
      await handleLogin(page);

      // --- PROJECT PROCESSING ---
      console.log("🔍 Scanning for projects...");

      // Ensure we're on the invites page (some login flows don't redirect reliably)
      try {
        await page.goto(`${CONFIG.baseUrl}/dashboard/invites`, CONFIG.navigation);
      } catch (err) {
        console.warn('Navigation to invites page failed, continuing to wait for projects on current page');
      }

      // Attempt to dismiss cookie/consent overlays that can block selectors
      try {
        await page.waitForSelector('#accept-recommended-btn-handler, #onetrust-accept-btn-handler', { timeout: 3000 });
        await page.evaluate(() => {
          const btn = document.querySelector('#accept-recommended-btn-handler') || document.querySelector('#onetrust-accept-btn-handler');
          if (btn) btn.click();
        });
        console.log('Cookie/consent banner dismissed');
      } catch (e) {
        // not critical
      }

      try {
        await page.waitForSelector(CONFIG.selectors.dashboard.projects, {
          timeout: 20000,
        });
      } catch (error) {
        if (error.name === "TimeoutError") {
          // Verify if projects are actually missing
          const projectsExist = await page.$(
            CONFIG.selectors.dashboard.projects
          );
          if (!projectsExist) {
            console.log("🚫 No available projects found");
            try {
              const ts = Date.now();
              await saveArtifacts(page, `no-projects-${ts}`);
              console.log(`📝 Saved diagnostic artifacts: errors/no-projects-${ts}.*`);
            } catch (e) {
              console.warn('Failed to save diagnostic artifacts for no-projects:', e.message);
            }
            return []; // Return empty array instead of error
          }
        }
        throw error;
      }

      // Use $$eval to get all matching elements (page.$eval returns a single node)
      const projectList = await page.$$eval(
        CONFIG.selectors.dashboard.projects,
        (items, selectors) =>
          Array.from(items).map((item) => ({
            title: item.querySelector(selectors.projectTitle)?.textContent?.trim(),
            url: item.href,
            meta: Array.from(item.querySelectorAll(selectors.projectMeta)).map(
              (el) => el.textContent.trim()
            ),
          })),
        CONFIG.selectors.dashboard
      );

      console.log('Extracted projectList:', projectList);

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
            console.log("⏩ Project has attachments - Requires Manual Review");
            fullProject.status = "Needs Review";
          } else if (
            !details.script ||
            details.script.length < MIN_SCRIPT_LENGTH
          ) {
            console.log(
              "🔍 Script too short or missing - Manual Review Needed"
            );
            fullProject.status = "Needs Review";
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
        try {
          const ts = Date.now();
          await saveArtifacts(page, `no-projects-final-${ts}`);
          console.log(`📝 Saved diagnostic artifacts: errors/no-projects-final-${ts}.*`);
        } catch (e) {
          console.warn('Failed to save diagnostic artifacts for final timeout:', e.message);
        }
        return []; // Return empty array instead of crashing
      }
      console.error("🚨 Critical error:", error);
      await page.screenshot({
        path: `errors/main-error-${Date.now()}.png`,
      });
      throw error;
    } finally {
      await page.close();
      await browser.close();
    }
  },
  // Add new upload function
  async uploadAudio(projectUrl, audioPath) {
    const browser = await connect();
    const page = await browser.newPage();
  // Keep track of the path we actually upload so we can clean up a temp file in finally
  let uploadPath = audioPath;
  let transcodedPath = null;
  // Capture runtime logs from the page
  const capturedLogs = { console: [], network: [] };
  page.on('console', msg => {
    try {
      capturedLogs.console.push({ type: msg.type(), text: msg.text(), location: msg.location() });
    } catch (e) {
      capturedLogs.console.push({ type: 'unknown', text: String(msg) });
    }
  });
  page.on('requestfinished', async (req) => {
    try {
      const res = req.response();
      const entry = { url: req.url(), method: req.method(), status: res ? res.status() : null };
      try {
        // Capture small response bodies for Transloadit/assembly endpoints so we
        // can diagnose server-side validation errors. Limit size to avoid huge
        // logs.
        if (res && /transloadit|assemblies/.test(req.url())) {
          const text = await res.text().catch(() => null);
          if (text) {
            // truncate to 200k chars to avoid massive logs
            entry.body = text.length > 200000 ? text.slice(0, 200000) + '\n...[truncated]' : text;
          }
        }
      } catch (e) {
        // ignore body extraction errors
      }
      capturedLogs.network.push(entry);
    } catch (e) {
      // ignore
    }
  });

  try {
      // 1. Validate file first
      validateAudioFile(audioPath);
      console.log('Validate audio');

      // Attempt to transcode to site-friendly format. If transcoding succeeds, we'll upload the transcoded file.
      try {
        transcodedPath = await transcodeAudio(audioPath);
      } catch (e) {
        console.warn('Transcode attempt failed:', e.message);
      }
      uploadPath = transcodedPath || audioPath;

      // 2. Navigate and login
      await handleLogin(page);
      await page.goto(projectUrl, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });

      // 3. Ensure invite is accepted (file input is often disabled until invite accepted)
      try {
        // If an invitation banner exists, click the Accept button inside it using the page context
        const toast = await page.$('.invitation-toast');
        if (toast) {
          console.log('Invitation toast detected - attempting to accept');
          const clicked = await page.evaluate(() => {
            const toastEl = document.querySelector('.invitation-toast');
            if (!toastEl) return false;
            const buttons = Array.from(toastEl.querySelectorAll('button'));
            const btn = buttons.find(b => /accept invite/i.test((b.textContent||'').trim()) || /\baccept\b/i.test((b.textContent||'').trim()));
            if (btn) {
              // dispatch a DOM click to ensure framework handlers run
              btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
              return true;
            }
            return false;
          });

          if (clicked) {
            // Wait for the toast to be removed and for the file input to become enabled
            await page.waitForSelector('.invitation-toast', { hidden: true, timeout: 10000 }).catch(() => {});
            await page.waitForSelector('input[type="file"]:not([disabled])', { timeout: 10000 }).catch(() => {});
            console.log('Accept invite clicked (if present)');
          } else {
            // no accept button found inside toast; continue
            console.log('No accept button found inside invitation toast');
          }
        }

        // 4. Wait for upload zone
        await page.waitForSelector('.upload-box', {
          visible: true,
          timeout: 20000,
        });
        console.log('Upload area found');
      } catch (e) {
        // not critical, continue and let later checks fail with diagnostics
        console.warn('Warning while attempting to accept invite or find upload area:', e.message);
      }
      console.log("Upload area found");

      // 5. Handle file input
      // Some pages hide the file input behind an 'Attach' button or similar.
      const attachButtonCandidates = ['button.attach-file', '.attach-file', '.vdl-uploader .attach', 'button[aria-label*="Attach"]', 'button[title*="Attach"]', '.upload-box .btn'];
      for (const btnSel of attachButtonCandidates) {
        try {
          const btn = await page.$(btnSel);
          if (btn) {
            console.log('Found attach button, clicking to reveal file input:', btnSel);
            await btn.click().catch(() => {});
            await waitFor(500);
            break;
          }
        } catch (e) {}
      }

      // If no attach button element matched, try clicking any visible element with likely text
      try {
        const textMatchers = [/your proposal/i, /make proposal/i, /send proposal/i, /attach file/i, /attach/i, /upload sample/i, /add file/i, /upload/i];
        const clicked = await page.evaluate((matchers) => {
          const serialize = (el) => (el.innerText || el.textContent || '').trim();
          const all = Array.from(document.querySelectorAll('button, a, div, span, label'));
          for (const el of all) {
            try {
              const txt = serialize(el);
              if (!txt) continue;
              for (const re of matchers) {
                const rx = new RegExp(re, 'i');
                if (rx.test(txt)) {
                  // prefer clickable elements
                  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
                  return { clicked: true, selectorText: txt.slice(0, 80) };
                }
              }
            } catch (e) { /* ignore */ }
          }
          return { clicked: false };
        }, textMatchers.map(r => r.source));
        if (clicked && clicked.clicked) {
          console.log('Clicked an element by text to reveal uploader:', clicked.selectorText || 'unknown');
          await waitFor(700);
        }
      } catch (e) {}

      // Explicitly click an element labeled 'YOUR PROPOSAL' (sometimes the tab)
      try {
        const clickedTab = await page.evaluate(() => {
          const candidates = Array.from(document.querySelectorAll('*')).filter(el => (el.innerText||'').trim().toUpperCase() === 'YOUR PROPOSAL');
          if (candidates.length) {
            candidates[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
            return true;
          }
          return false;
        });
        if (clickedTab) {
          console.log('Clicked YOUR PROPOSAL tab');
          await waitFor(700);
        }
      } catch (e) {}
      // Try configured selector first, then some sensible fallbacks
      const candidateFileSelectors = [
        (CONFIG.selectors.project.upload && CONFIG.selectors.project.upload.fileInput) || null,
        'input[type="file"]',
        '.vdl-uploader input[type="file"]',
        '.upload-box input[type="file"]',
        'input[name="file"]'
      ].filter(Boolean);

      let fileInput = null;
      // Deterministic dump: write innerHTML snippets of likely upload containers to a file
      try {
        const dumpSelectors = ['.upload-box', '.vdl-uploader', '.dropzone', '.uploader', '.upload-zone', '.vdl-drop-area'];
        const snippets = {};
        for (const ds of dumpSelectors) {
          try {
            const html = await page.evaluate((s) => {
              const el = document.querySelector(s);
              return el ? el.innerHTML.slice(0, 20000) : null;
            }, ds);
            if (html) snippets[ds] = html;
          } catch (e) {}
        }
        // Also include a small snapshot of the entire body text to help find 'Attach' buttons
        try {
          const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 20000));
          snippets['_bodyText'] = bodyText;
        } catch (e) {}
        try {
          const dumpPath = `errors/upload-ui-dump-${Date.now()}.json`;
          const fs = require('fs');
          fs.writeFileSync(dumpPath, JSON.stringify(snippets, null, 2));
          console.log('WROTE_UI_DUMP', dumpPath);
        } catch (e) {
          console.warn('Failed to write UI dump:', e && e.message ? e.message : e);
        }
      } catch (e) {}

      // Thorough diagnostic dump: enumerate file inputs and candidate upload elements
      try {
        const info = await page.evaluate(() => {
          const out = { fileInputs: [], candidates: [], buttonsByText: [], rawPageSearch: null };
          // list input[type=file]
          const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
          out.fileInputs = fileInputs.map((el) => ({ outerHTML: el.outerHTML.slice(0, 2000), id: el.id || null, name: el.name || null, class: el.className || null }));

          // candidate elements by attribute names and classes
          const keywords = ['upload', 'attach', 'file', 'proposal', 'dropzone', 'uploader'];
          const all = Array.from(document.querySelectorAll('*'));
          for (const el of all) {
            try {
              const attrs = [el.id, el.className, el.getAttribute && el.getAttribute('name'), el.getAttribute && el.getAttribute('aria-label'), el.getAttribute && el.getAttribute('title')].filter(Boolean).map(String).join(' ');
              const hay = (attrs + ' ' + (el.innerText || '')).toLowerCase();
              for (const k of keywords) {
                if (hay.includes(k)) {
                  out.candidates.push({ tag: el.tagName, snippet: (el.outerHTML || '').slice(0, 2000), id: el.id || null, class: el.className || null, text: (el.innerText || '').trim().slice(0,200) });
                  break;
                }
              }
            } catch (e) { }
          }

          // Buttons by likely text
          const btnMatchers = [/attach/i, /upload/i, /proposal/i, /add file/i, /add attachment/i, /send proposal/i];
          const buttons = Array.from(document.querySelectorAll('button, a'));
          for (const b of buttons) {
            try {
              const t = (b.innerText || b.textContent || '').trim();
              for (const re of btnMatchers) if (re.test(t)) { out.buttonsByText.push({ text: t.slice(0,200), outerHTML: (b.outerHTML||'').slice(0,1000) }); }
            } catch (e) {}
          }

          // Raw page content search for type="file" (fallback)
          try { out.rawPageSearch = document.documentElement && document.documentElement.innerHTML && document.documentElement.innerHTML.indexOf('type="file"') !== -1; } catch (e) { out.rawPageSearch = null; }
          return out;
        });
        try {
          const dumpPath2 = `errors/upload-ui-full-dump-${Date.now()}.json`;
          const fs2 = require('fs');
          fs2.writeFileSync(dumpPath2, JSON.stringify(info, null, 2));
          console.log('WROTE_UI_FULL_DUMP', dumpPath2);
        } catch (e) {
          console.warn('Failed to write full UI dump:', e && e.message ? e.message : e);
        }
      } catch (e) {}
      for (const sel of candidateFileSelectors) {
        try {
          fileInput = await page.$(sel);
          if (fileInput) break;
        } catch (e) {
          // ignore selector errors
        }
      }

      // If no native input found, try a dropzone / drag-and-drop fallback
      if (!fileInput) {
        const dropCandidates = ['.upload-box', '.vdl-uploader', '.dropzone', '.uploader', '.vdl-drop-area'];
        let dropSelector = null;
        for (const s of dropCandidates) {
          try {
            const el = await page.$(s);
            if (el) { dropSelector = s; break; }
          } catch (e) {}
        }

        if (dropSelector) {
          console.log('No input[type=file] found — attempting dropzone DataTransfer fallback on', dropSelector);
          try {
            const b64 = fs.readFileSync(uploadPath, { encoding: 'base64' });
            const name = path.basename(uploadPath);
            const mime = uploadPath.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav';
            await page.evaluate(async (sel, b64Data, filename, mimeType) => {
              const byteChars = atob(b64Data);
              const byteNumbers = new Array(byteChars.length);
              for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
              const byteArray = new Uint8Array(byteNumbers);
              const blob = new Blob([byteArray], { type: mimeType });
              const file = new File([blob], filename, { type: mimeType });
              const dt = new DataTransfer();
              dt.items.add(file);
              const target = document.querySelector(sel);
              if (!target) return { error: 'drop-target-not-found' };
              const evt = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
              target.dispatchEvent(evt);
              // expose for diagnostics
              window.__droppedFile = { name: file.name, size: file.size, type: file.type };
              return { ok: true };
            }, dropSelector, b64, name, mime);

            // small delay to let the page react
            await waitFor(600);
            const dropped = await page.evaluate(() => window.__droppedFile || null);
            if (dropped && dropped.size) {
              console.log('Drop fallback attached file size:', dropped.size);
            } else {
              console.warn('Drop fallback did not register a file on the page');
            }
          } catch (e) {
            console.warn('Dropzone fallback failed:', e && e.message ? e.message : e);
          }
        } else {
          throw new Error('File input element not found on page');
        }
      }

      // If we found a fileInput element earlier, make sure it's enabled
      if (fileInput) {
        const isDisabled = await page.evaluate(el => el.disabled === true, fileInput);
        if (isDisabled) {
          // try to remove disabled attribute if present
          await page.evaluate(el => el.removeAttribute('disabled'), fileInput).catch(() => {});
          // wait a short moment for changes
          await waitFor(500);
        }
      }

  // upload the file via the file input
  await fileInput.uploadFile(uploadPath);

      // Quick check: ensure the browser registered the file on the input element
      // Dispatch input/change events so site JS picks up the new file (some frameworks
      // only validate on these events and reject otherwise).
      try {
        await page.evaluate(() => {
          const input = document.querySelector('input[type="file"]');
          if (input) {
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
        // small pause for event handlers to run
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        // non-fatal
      }
      const filesCount = await page.evaluate(() => {
        const input = document.querySelector('input[type="file"]');
        if (input && input.files && input.files.length) {
          // Expose file details for logging
          window.__uploadedFile = input.files[0];
          return input.files.length;
        }
        return 0;
      });
      if (!filesCount || filesCount === 0) {
        const ts = Date.now();
        await saveArtifacts(page, `upload-no-file-attached-${ts}`).catch(() => {});
        throw new Error('File attach failed: input.files is empty after uploadFile');
      }

      // Log file details if present
      try {
        const fileInfo = await page.evaluate(() => {
          const f = window.__uploadedFile;
          if (!f) return null;
          return { name: f.name, size: f.size, type: f.type };
        });
        if (fileInfo) console.log(`Attached file -> name: ${fileInfo.name}, size: ${fileInfo.size}, type: ${fileInfo.type}`);
      } catch (e) {
        // ignore
      }

      // If the attached file appears to be empty (some sites clear the input or
      // require a DataTransfer / drag-drop flow), attempt a fallback: read the
      // local file bytes and create a File in the page context via DataTransfer
      // so input.files contains a real Blob object. This addresses cases where
      // `uploadFile()` sets the input but the page's JS doesn't pick up the file
      // or the File object is opaque/zero-sized for their upload pipeline.
      const attachedSize = await page.evaluate(() => {
        const input = document.querySelector('input[type="file"]');
        if (!input || !input.files || input.files.length === 0) return -1;
        return input.files[0].size || 0;
      });
      if (attachedSize === 0) {
        console.log('Detected attached file size 0; attempting DataTransfer fallback');
        try {
          // Read file from Node and pass its binary to the page as base64
          const b64 = fs.readFileSync(uploadPath, { encoding: 'base64' });
          const name = path.basename(uploadPath);
          const mime = uploadPath.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav';

          // Inject the file into the input using the File constructor and DataTransfer
          await page.evaluate(async (b64Data, filename, mimeType) => {
            try {
              const byteChars = atob(b64Data);
              const byteNumbers = new Array(byteChars.length);
              for (let i = 0; i < byteChars.length; i++) {
                byteNumbers[i] = byteChars.charCodeAt(i);
              }
              const byteArray = new Uint8Array(byteNumbers);
              const blob = new Blob([byteArray], { type: mimeType });
              const file = new File([blob], filename, { type: mimeType });
              const dt = new DataTransfer();
              dt.items.add(file);
              const input = document.querySelector('input[type="file"]');
              input.files = dt.files;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              // expose for diagnostics
              window.__uploadedFile = input.files[0];
              return true;
            } catch (e) {
              // propagate to caller
              return { error: String(e) };
            }
          }, b64, name, mime);

          // small delay to allow site JS to react
          await waitFor(600);

          const newSize = await page.evaluate(() => {
            const input = document.querySelector('input[type="file"]');
            if (!input || !input.files || input.files.length === 0) return -1;
            return input.files[0].size || 0;
          });
          console.log('DataTransfer fallback attached file size:', newSize);
        } catch (e) {
          console.warn('DataTransfer fallback failed:', e.message || e);
        }
      }

  // 6. Wait for file validation: pass both a failure selector and success selector and accept either success or cleared failure
      const failureSelector = (CONFIG.selectors.project.upload && CONFIG.selectors.project.upload.failureIndicator) || '.upload-box-container .file-restriction, .upload-box-container .md-error, .upload-box + .md-error, .md-error';
      const successSelector = (CONFIG.selectors.project.upload && CONFIG.selectors.project.upload.successIndicator) || '.upload-success, .vdl-uploader .uploaded'
      try {
        await page.waitForFunction(
          (fSel, sSel) => {
            try {
              const success = document.querySelector(sSel);
              if (success) return true;
              const fail = document.querySelector(fSel);
              if (!fail) return true; // no visible error element
              const txt = (fail.textContent || '').trim();
              if (!txt) return true; // empty text means no error
              // consider visibility
              const style = window.getComputedStyle(fail);
              if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return true;
              return false;
            } catch (e) {
              return false;
            }
          },
          { timeout: 20000 },
          failureSelector,
          successSelector
        );
      } catch (validationError) {
        // Validation timed out => file likely rejected. Save artifacts for debugging.
        try {
          const ts = Date.now();
          await saveArtifacts(page, `upload-validate-failure-${ts}`, capturedLogs);
          console.log(`📝 Saved diagnostic artifacts: errors/upload-validate-failure-${ts}.*`);
        } catch (e) {
          console.warn('Failed to save diagnostic artifacts for upload validation:', e.message);
        }
        // If we uploaded WAV, try to transcode to MP3 and retry once
        const attemptedWasWav = uploadPath.endsWith('.wav');
        if (attemptedWasWav) {
          console.log('Validation failed for WAV. Retrying with MP3 fallback...');
          try {
            const mp3Path = await transcodeAudio(audioPath, [
              {
                ext: 'mp3',
                args: [
                  '-ar', '44100',
                  '-ac', '1',
                  '-codec:a', 'libmp3lame',
                  '-b:a', '128k',
                  '-af', 'volume=-3dB'
                ]
              }
            ]);
            if (mp3Path) {
              // Clear file input and re-upload
              await page.evaluate(() => {
                const input = document.querySelector('input[type="file"]');
                if (input) input.value = '';
              });
              uploadPath = mp3Path;
              await fileInput.uploadFile(uploadPath);
              // allow a short delay and re-run validation wait
              await waitFor(500);
              await page.waitForFunction(
                (fSel, sSel) => {
                  try {
                    const success = document.querySelector(sSel);
                    if (success) return true;
                    const fail = document.querySelector(fSel);
                    if (!fail) return true;
                    const txt = (fail.textContent || '').trim();
                    if (!txt) return true;
                    const style = window.getComputedStyle(fail);
                    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return true;
                    return false;
                  } catch (e) {
                    return false;
                  }
                },
                { timeout: 20000 },
                failureSelector,
                successSelector
              );
            }
          } catch (mp3Err) {
            // continue to throw original validation error after fallback attempt
          }
        }
        throw new Error('File validation failed or timed out - site reported invalid file');
      }
      console.log('File validated or upload success detected');
      // 6. Handle submit button
      const submitButton = await page.waitForSelector("#submit", {
        visible: true,
        timeout: 20000,
      });

      await submitButton.scrollIntoView();
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Ensure visibility
      // Before submitting, ensure budget-dependent fields are set correctly
      try {
        const selectors = {
          budgetSelector: CONFIG.selectors.project.upload.budgetLabel,
          priceQuoteSelector: CONFIG.selectors.project.upload.priceQuote,
          additionalProposalSelector: CONFIG.selectors.project.upload.additionalProposal,
        };
        const budgetResult = await ensureBudgetFields(page, selectors);
        console.log('Budget field check result:', budgetResult);
      } catch (e) {
        console.warn('ensureBudgetFields failed:', e && e.message ? e.message : e);
      }

      // Click submit. The site may perform an XHR upload and not navigate, so
      // don't block on navigation. Wait for the known success selector first,
      // and fall back to a short navigation wait if necessary.
      await submitButton.click();
      console.log("Submit button pressed, waiting for success indicator or page transition...");

      let uploadSucceeded = false;

      // Fast path: explicit success selector appears
      try {
        await page.waitForSelector(successSelector, { timeout: 30000 });
        uploadSucceeded = true;
        console.log('Detected explicit success selector on page');
      } catch (e1) {
        // Try backend assembly / offers responses (may take longer)
        try {
          const assemblyResp = await page.waitForResponse(
            (res) =>
              (/api2(-u[0-9]+)?\.transloadit\.com\/assemblies\//.test(res.url()) && res.status() === 200) ||
              (/voice123\.com\/api\/offers\/.+/.test(res.url()) && (res.request().method() === 'PATCH' || res.request().method() === 'POST')),
            { timeout: 45000 }
          );
          if (assemblyResp) {
            uploadSucceeded = true;
            console.log('Detected assembly/offers response:', assemblyResp.url());
          }
        } catch (e2) {
          // Try a short navigation wait — many successful submissions redirect back to the SPECS view
          try {
            await page.waitForNavigation({ waitUntil: "networkidle0", timeout: 10000 });
            uploadSucceeded = true;
            console.log('Navigation detected after submit (possible SPECS redirect)');
          } catch (e3) {
            // Final fallback: detect removal of upload UI or arrival on SPECS text
            try {
              await page.waitForFunction(() => {
                try {
                  if (!document.querySelector('.upload-box')) return true; // upload UI removed
                  const bodyText = (document.body && document.body.innerText) || '';
                  if (bodyText.includes('SPECS')) return true; // likely landed on specs view
                  return false;
                } catch (err) {
                  return false;
                }
              }, { timeout: 20000 });
              uploadSucceeded = true;
              console.log('Detected SPECS page or upload UI removed (considered success)');
            } catch (e4) {
              uploadSucceeded = false;
            }
          }
        }
      }

      // Diagnostic: if still not succeeded, log captured network hints
      if (!uploadSucceeded) {
        try {
          const matches = capturedLogs.network.filter(n => /transloadit|assemblies|\/api\/offers\//.test(n.url));
          console.log('Captured network entries matching upload signals:', matches.map(m => ({ url: m.url, status: m.status })));
        } catch (diagErr) {
          console.warn('Failed to introspect captured network logs:', diagErr && diagErr.message ? diagErr.message : diagErr);
        }
      }

      if (!uploadSucceeded) {
        throw new Error('Submit did not produce success indicator, navigation, or SPECS view');
      }
      console.log('Upload succeeded (detected by success selector, assembly response, navigation, or SPECS view)');
      return true;
  } catch (error) {
      console.error("Upload failed:", error);
      try {
        const ts = Date.now();
  await saveArtifacts(page, `upload-error-${ts}`, capturedLogs);
  console.log(`📝 Saved diagnostic artifacts: errors/upload-error-${ts}.*`);
      } catch (e) {
        console.warn('Failed to save artifacts during upload failure:', e.message);
        await page.screenshot({ path: `errors/upload-error-${Date.now()}.png` });
      }
      return false;
  } finally {
      // Clean up transcoded temp file if created
      try {
        if (transcodedPath && transcodedPath !== audioPath && fs.existsSync(transcodedPath)) {
          fs.removeSync(transcodedPath);
          console.log('Removed transcoded temp file:', transcodedPath);
        }
      } catch (e) {
        console.warn('Failed to remove temp file:', e.message);
      }

      await page.close();
      await browser.close();
  }
  },
};
