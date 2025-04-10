const puppeteer = require('puppeteer-core');

module.exports.connect = async () => {
  return await puppeteer.connect({
    browserWSEndpoint: `wss://chrome.browserless.io?token=${process.env.BROWSERLESS_API_KEY}`
  });
};