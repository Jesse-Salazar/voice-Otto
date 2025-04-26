const fs = require('fs');
const path = require('path');
const util = require('util');
const colors = require('colors'); // Optional: npm install colors

// Create errors directory if not exists
const ERROR_DIR = path.join(__dirname, 'errors');
if (!fs.existsSync(ERROR_DIR)) {
  fs.mkdirSync(ERROR_DIR, { recursive: true });
}

// Promisify file operations
const writeFile = util.promisify(fs.writeFile);

async function handleError(page, context, error) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const prefix = `[${context}] [${timestamp}]`;
  
  try {
    // Enhanced error logging
    console.error(colors.red(`${prefix} Error: ${error.message}`));
    console.error(colors.grey(error.stack));

    // Capture multiple artifacts
    const artifacts = {
      screenshot: path.join(ERROR_DIR, `${context}-${timestamp}.png`),
      pageHTML: path.join(ERROR_DIR, `${context}-${timestamp}.html`),
      consoleLog: path.join(ERROR_DIR, `${context}-${timestamp}.console.log`),
      errorLog: path.join(ERROR_DIR, `${context}-${timestamp}.error.log`)
    };

    // Parallel artifact collection
    await Promise.all([
      page.screenshot({ path: artifacts.screenshot }),
      page.content().then(html => writeFile(artifacts.pageHTML, html)),
      page.evaluate(() => JSON.stringify(console._logs))
        .then(logs => writeFile(artifacts.consoleLog, logs)),
      writeFile(artifacts.errorLog, `${error.message}\n\n${error.stack}`)
    ]);

    console.log(colors.yellow(`Saved error artifacts to: ${ERROR_DIR}/${context}-${timestamp}.*`));

  } catch (artifactError) {
    console.error(colors.red('Failed to save error artifacts:'), artifactError);
  }
}

function waitFor(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Alias for backward compatibility
const waitForElf = waitFor;

async function retry(fn, options = {}) {
  const {
    retries = 3,
    delayMs = 1000,
    backoffFactor = 2,
    context = 'retry'
  } = options;

  let attempt = 0;
  let currentDelay = delayMs;

  while (attempt < retries) {
    try {
      return await fn();
    } catch (error) {
      attempt++;
      console.warn(colors.yellow(`[${context}] Attempt ${attempt}/${retries} failed: ${error.message}`));
      
      if (attempt >= retries) throw error;
      await waitFor(currentDelay);
      currentDelay *= backoffFactor;
    }
  }
}

function log(context, message, level = 'info') {
  const timestamp = new Date().toISOString();
  const levels = {
    info: colors.cyan,
    warn: colors.yellow,
    error: colors.red,
    success: colors.green
  };
  
  const color = levels[level] || colors.reset;
  console.log(color(`[${timestamp}] [${context}] ${message}`));
}

module.exports = {
  handleError,
  waitFor,
  waitForElf, // Backward compatibility
  retry,
  log,
  
  // Utility functions
  saveArtifacts: async (page, context) => {
    const timestamp = Date.now();
    return {
      screenshot: await page.screenshot({ path: `errors/${context}-${timestamp}.png` }),
      html: await page.content().then(html => 
        writeFile(`errors/${context}-${timestamp}.html`, html))
    };
  }
};

module.exports.safeQuerySelector = async (page, selector, fallback = '') => {
  if (!selector) return fallback;
  try {
    return await page.$eval(selector, el => el.textContent.trim());
  } catch (error) {
    return fallback;
  }
};