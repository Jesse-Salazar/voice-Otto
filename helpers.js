const fs = require('fs');

async function handleError(page, context, error) {
  console.error(`[${context}] Error:`, error.message);
  const timestamp = Date.now();
  
  try {
    await page.screenshot({ path: `errors/${context}-${timestamp}.png` });
    fs.writeFileSync(`errors/${context}-${timestamp}.log`, error.stack);
  } catch (err) {
    console.error('Failed to save error artifacts:', err);
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  handleError,
  delay
};