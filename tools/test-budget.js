const puppeteer = require('puppeteer');
const path = require('path');
const { ensureBudgetFields } = require('../helpers');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  try {
    const htmlPath = path.resolve(__dirname, '../errors/upload-error-1758766999780-1758766999781.html');
    console.log('Loading file://', htmlPath);
    await page.goto('file://' + htmlPath, { waitUntil: 'load', timeout: 30000 });

    // Run ensureBudgetFields with default selectors
    const selectors = {
      budgetSelector: '.budget-label',
      priceQuoteSelector: 'input[name="price_quote"]',
      additionalProposalSelector: 'textarea[name="proposal_details"]'
    };

    const result = await ensureBudgetFields(page, selectors);
    console.log('ensureBudgetFields result:', result);

    const values = await page.evaluate(() => {
      const candidates = {
        price: [
          'input[name="price_quote"]',
          'input[name="component_value"]',
          'input#input-component_unit-juanse',
          'input[name="price"]',
          'input[name="amount"]',
          'input[type="number"]'
        ],
        proposal: [
          'textarea[name="proposal_details"]',
          'textarea#details',
          'textarea[name="details"]',
          'textarea[name="proposal"]',
          'textarea[name="additional_proposal"]'
        ],
        budget: ['.budget-label', '#project_budget', '#budget', 'div.content.clickable', '.field-value-text']
      };

      const pick = (arr, type) => {
        for (const s of arr) try { const el = document.querySelector(s); if (el) return { selector: s, value: el.value || el.textContent || null }; } catch (e) {}
        return { selector: null, value: null };
      };

      return {
        price: pick(candidates.price),
        proposal: pick(candidates.proposal),
        budget: pick(candidates.budget)
      };
    });

    console.log('Field values after ensureBudgetFields:', values);
  } catch (e) {
    console.error('Test failed:', e);
    process.exitCode = 2;
  } finally {
    await browser.close();
  }
})();
