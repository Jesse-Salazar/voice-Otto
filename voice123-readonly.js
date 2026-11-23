const path = require("path");
const puppeteer = require("puppeteer");
const { ORIGIN, projectIdentity } = require("./voice123-projects");

const invites = ORIGIN + "/dashboard/invites";
const accountMetadata = ORIGIN + "/api/users/me";

function allowReadOnlyRequest(request, target, connectivityOnly = false) {
  let url;
  try {
    url = new URL(request.url());
  } catch {
    return false;
  }
  if (connectivityOnly) {
    if (target !== invites || request.method() !== "GET" || url.protocol !== "https:" ||
        !/(^|\.)voice123\.com$/i.test(url.hostname)) return false;
    if (request.isNavigationRequest()) return url.href === invites;
    if (["xhr", "fetch"].includes(request.resourceType())) return url.href === accountMetadata;
    return ["script", "stylesheet", "image", "font"].includes(request.resourceType()) &&
      /\.(?:m?js|css|svg|png|jpe?g|webp|ico|woff2?|ttf)$/i.test(url.pathname) &&
      !/\/(?:api|messages?|threads?|conversations?|drafts?|proposals?|offers?|upload|submit|accept|decline|send|attachments?|downloads?)(?:[./_-]|$)/i.test(url.pathname);
  }
  if (request.method() !== "GET" ||
      url.protocol !== "https:" ||
      !/(^|\.)voice123\.com$/i.test(url.hostname) ||
      url.username || url.password || url.search || url.hash) return false;

  if (request.isNavigationRequest()) {
    return url.href === target;
  }

  return ["script", "stylesheet", "image", "font"].includes(request.resourceType()) &&
    /\.(?:m?js|css|svg|png|jpe?g|webp|ico|woff2?|ttf)$/i.test(url.pathname) &&
    !/\/(?:api|messages?|threads?|conversations?|drafts?|proposals?|offers?|upload|submit|accept|decline|send|attachments?|downloads?)(?:[./_-]|$)/i.test(url.pathname);
}

async function connectReadOnly() {
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: path.join(__dirname, ".chrome-user-data"),
    defaultViewport: { width: 1280, height: 800 }
  });
  try {
    const session = await browser.target().createCDPSession();
    await session.send("Browser.setDownloadBehavior", { behavior: "deny" });
    return browser;
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function readOnlyPage(browser, target, { connectivityOnly = false } = {}) {
  if (connectivityOnly ? target !== invites : target !== invites && projectIdentity(target)?.url !== target) {
    throw new Error("Invalid read-only target");
  }
  const page = await browser.newPage();
  try {
    const session = await page.createCDPSession();
    await session.send("Network.enable");
    await session.send("Network.setBlockedURLs", { urls: ["ws://*", "wss://*"] });
    await page.setBypassServiceWorker(true);
    await page.setCacheEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", request => {
      if (request.isInterceptResolutionHandled()) return;
      const allowed = allowReadOnlyRequest(request, target, connectivityOnly);
      (allowed ? request.continue() : request.abort()).catch(() => {});
    });
    return page;
  } catch (error) {
    await page.close();
    throw error;
  }
}

module.exports = { connectReadOnly, readOnlyPage, allowReadOnlyRequest };
