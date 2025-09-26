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
  // saveArtifacts now accepts an optional `logs` object with `console` and `network` arrays.
  saveArtifacts: async (page, context, logs = {}) => {
    const timestamp = Date.now();
    const screenshotPath = `errors/${context}-${timestamp}.png`;
    const htmlPath = `errors/${context}-${timestamp}.html`;

    // Capture screenshot and HTML
    await page.screenshot({ path: screenshotPath });
    const html = await page.content();
    await writeFile(htmlPath, html);

    // Save console logs if provided
    if (logs.console && Array.isArray(logs.console)) {
      try {
        const consolePath = `errors/${context}-${timestamp}.console.log`;
        const out = logs.console.map(entry => {
          try { return JSON.stringify(entry); } catch (e) { return String(entry); }
        }).join('\n');
        await writeFile(consolePath, out);
      } catch (e) {
        // non-fatal
      }
    }

    // Save network logs if provided
    if (logs.network && Array.isArray(logs.network)) {
      try {
        const networkPath = `errors/${context}-${timestamp}.network.log`;
        const out = logs.network.map(entry => {
          try { return JSON.stringify(entry); } catch (e) { return String(entry); }
        }).join('\n');
        await writeFile(networkPath, out);
      } catch (e) {
        // non-fatal
      }
    }

    return { screenshot: screenshotPath, html: htmlPath };
  }
};

// Small DOM helpers to set/get inputs reliably from Node context
async function setInputValue(page, selector, value, opts = {}) {
  const { dispatch = true, blur = true } = opts;
  try {
    const result = await page.evaluate(
      (sel, val, dispatchEvents, doBlur) => {
        const el = document.querySelector(sel);
        if (!el) return { ok: false, reason: 'not-found' };
        try {
          // Prefer using native value setter to trigger React/Vue listeners
          try {
            const descriptor = Object.getOwnPropertyDescriptor(el.__proto__, 'value');
            if (descriptor && descriptor.set) {
              descriptor.set.call(el, val);
            } else if ('value' in el) {
              el.value = val;
            } else {
              el.textContent = val;
            }
          } catch (innerErr) {
            // Fallback
            if ('value' in el) el.value = val;
            else el.textContent = val;
          }

          if (dispatchEvents) {
            // Dispatch different event types to cover frameworks
            const inputEvent = typeof InputEvent === 'function'
              ? new InputEvent('input', { bubbles: true })
              : new Event('input', { bubbles: true });
            const changeEvent = new Event('change', { bubbles: true });
            el.dispatchEvent(inputEvent);
            el.dispatchEvent(changeEvent);

            // Some frameworks listen for 'compositionend' or 'blur' too
            try { el.dispatchEvent(new Event('compositionend', { bubbles: true })); } catch (e) {}
          }
          if (doBlur && typeof el.blur === 'function') el.blur();
          return { ok: true };
        } catch (e) {
          return { ok: false, reason: String(e) };
        }
      },
      selector,
      value,
      dispatch,
      blur
    );
    return result.ok === true;
  } catch (e) {
    return false;
  }
}

async function getElementText(page, selector) {
  if (!selector) return null;
  try {
    return await page.$eval(selector, (el) => (el ? el.textContent.trim() : null));
  } catch (e) {
    // fallback: try querySelector in page context to be defensive
    try {
      return await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? (el.textContent || '').trim() : null;
      }, selector);
    } catch (ee) {
      return null;
    }
  }
}

/**
 * Ensure budget-dependent fields are populated before submit.
 * selectors: { budgetSelector, priceQuoteSelector, additionalProposalSelector }
 * Returns an object describing actions taken.
 */
async function ensureBudgetFields(page, selectors = {}) {
  const { budgetSelector, priceQuoteSelector, additionalProposalSelector } = selectors;
  try {
    // Try configured selector first, then a set of known candidates from the saved snapshot
    const budgetCandidates = [budgetSelector, '#project_budget', '#budget', 'div.content.clickable', '.field-value-text', '.vdl-expandable-text .content'];
    const budgetMatch = await page.evaluate((cands) => {
      for (const s of cands) {
        try {
          if (!s) continue;
          const el = document.querySelector(s);
          if (el) return { selector: s, text: (el.textContent || '').trim() };
        } catch (e) { /* ignore */ }
      }
      // fallback: scan for keywords anywhere in body
      const keywords = ['zero budget', 'looking for a quote'];
      const all = Array.from(document.querySelectorAll('body *'));
      for (const el of all) {
        try {
          const txt = (el.textContent || '').toLowerCase();
          for (const k of keywords) if (txt.includes(k)) return { selector: null, text: txt };
        } catch (e) {}
      }
      return null;
    }, budgetCandidates);

    if (!budgetMatch || !budgetMatch.text) return { changed: false, reason: 'budget-label-not-found' };
    const txt = budgetMatch.text.toLowerCase();
    if (txt.includes('zero budget')) {
      // Determine price input selector if missing: try priceQuoteSelector, then label-based lookup
      // Prefer known selectors observed in snapshot (stable names) then fallbacks
      const priceCandidates = [priceQuoteSelector, 'input[name="component_value"]', 'input[name="price_quote"]', 'input[name="price"]', 'input[name="amount"]', 'input[type="number"]'];
      const priceSel = await page.evaluate((cands) => {
        for (const s of cands) {
          if (!s) continue;
          try { if (document.querySelector(s)) return s; } catch (e) {}
        }
        return null;
      }, priceCandidates);
      const ok = await setInputValue(page, priceSel, '0');
      // Also attempt to set the currency selector used in the unit input
      try {
        await page.evaluate(() => {
          const sel = document.querySelector('#component_currency') || document.querySelector('select[name="component_unit"]') || document.querySelector('select[id*="component_currency"]');
          if (sel) {
            // pick the first non-empty option if present
            const opt = Array.from(sel.options).find(o => o.value && o.value.trim() !== '') || sel.options[0];
            if (opt) {
              sel.value = opt.value;
              sel.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
        });
      } catch (e) { /* non-fatal */ }
      return { changed: ok, action: 'zero-budget', ok };
    }
    if (txt.includes('looking for a quote')) {
      // Find price input and additional proposal input if selectors missing
      let priceSel = priceQuoteSelector;
      let propSel = additionalProposalSelector;
      const priceCandidates = [priceSel, 'input[name="component_value"]', 'input[name="price_quote"]', 'input[name="price"]', 'input[name="amount"]', 'input[type="number"]'];
      const propCandidates = [propSel, 'textarea#details', 'textarea[name="details"]', 'textarea[name="proposal_details"]', 'textarea[name="proposal"]', 'textarea[name="additional_proposal"]'];
      const found = await page.evaluate((pCands, prCands) => {
        const out = { price: null, proposal: null };
        for (const s of pCands) {
          if (!s) continue;
          try { if (document.querySelector(s)) { out.price = s; break; } } catch (e) {}
        }
        for (const s of prCands) {
          if (!s) continue;
          try { if (document.querySelector(s)) { out.proposal = s; break; } } catch (e) {}
        }
        return out;
      }, priceCandidates, propCandidates);
      if (found.price) priceSel = found.price;
      if (found.proposal) propSel = found.proposal;
      const ok1 = await setInputValue(page, priceSel, '125');
      // set currency as well for the unit input to ensure framework model updates
      try {
        await page.evaluate(() => {
          const sel = document.querySelector('#component_currency') || document.querySelector('select[name="component_unit"]') || document.querySelector('select[id*="component_currency"]');
          if (sel) {
            const opt = Array.from(sel.options).find(o => o.value && o.value.trim() !== '') || sel.options[0];
            if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
          }
        });
      } catch (e) {}
      const ok2 = await setInputValue(page, propSel, '125 PFH.');
      return { changed: ok1 && ok2, action: 'looking-for-quote', ok1, ok2 };
    }
    return { changed: false, reason: 'no-budget-action' };
  } catch (e) {
    return { changed: false, error: String(e) };
  }
}

module.exports.setInputValue = setInputValue;
module.exports.getElementText = getElementText;
module.exports.ensureBudgetFields = ensureBudgetFields;

module.exports.safeQuerySelector = async (page, selector, fallback = '') => {
  if (!selector) return fallback;
  try {
    return await page.$eval(selector, el => el.textContent.trim());
  } catch (error) {
    return fallback;
  }
};