const puppeteer = require('puppeteer-core');

module.exports.connect = async () => {
  const chromeArgs = [
    '--disable-features=site-per-process',
    '--no-sandbox',
    '--disable-setuid-sandbox'
  ];

  return await puppeteer.connect({
    browserWSEndpoint: `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_API_KEY}&launch=${encodeURIComponent(chromeArgs.join(' '))}`
  });
};