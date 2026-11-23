const { verifyLocalConfiguration } = require("./connectivity-local");

function assertSafeSwitches(env) {
  if ((env.DRY_RUN !== undefined && env.DRY_RUN !== "true") ||
      [env.ENABLE_PAID_GENERATION, env.ENABLE_VOICE123_SUBMISSION].some(value => value !== undefined && value !== "false")) {
    throw new Error("Read-only connectivity requires dry-run mode and disabled production switches");
  }
}

async function checkVoice123(env) {
  const { connectReadOnly, readOnlyPage } = require("./voice123-readonly");
  const target = "https://voice123.com/dashboard/invites";
  const accountMetadata = "https://voice123.com/api/users/me";
  const expectedEmail = env.VOICE123_EMAIL?.trim().toLowerCase();
  if (!expectedEmail) throw new Error("Missing expected Voice123 account");
  const browser = await connectReadOnly();
  try {
    const page = await readOnlyPage(browser, target, { connectivityOnly: true });
    // The browser session supplies authorization during the app bootstrap.
    // The rendered dashboard is irrelevant to the identity-only probe.
    const [, navigation] = await Promise.all([
      page.waitForResponse(async response => {
        if (response.url() !== accountMetadata || !response.ok() || response.request().method() !== "GET") return false;
        const metadata = await response.json().catch(() => null);
        return [metadata, metadata?.user, metadata?.data, metadata?.data?.user].some(value =>
          (typeof value?.id === "string" && Boolean(value.id.trim()) || Number.isSafeInteger(value?.id) && value.id > 0) &&
          typeof value.email === "string" && value.email.trim().toLowerCase() === expectedEmail);
      }, { timeout: 15000 }),
      page.goto(target, { waitUntil: "domcontentloaded", timeout: 25000 })
    ]);
    if (!navigation?.ok() || navigation.url() !== target) throw new Error("Voice123 session metadata unavailable");
  } finally {
    await browser.close();
  }
}

async function checkGoogleSheets(env) {
  const { JWT } = require("google-auth-library");
  const id = env.GOOGLE_SHEET_ID;
  if (!/^[a-zA-Z0-9_-]+$/.test(id || "") || !env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_PRIVATE_KEY) {
    throw new Error("Missing Google read configuration");
  }
  const auth = new JWT({
    email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
  });
  const response = await auth.request({
    method: "GET", url: `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=spreadsheetId`,
    maxRedirects: 0, timeout: 8000, retry: false
  });
  if (response.data?.spreadsheetId !== id) throw new Error("Configured spreadsheet identity could not be verified");
}

async function checkAwsIdentity(env) {
  const STS = require("aws-sdk/clients/sts");
  const region = env.AWS_REGION;
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/.test(region || "") || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    throw new Error("Missing AWS identity configuration");
  }
  const sts = new STS({
    region, endpoint: `https://sts.${region}.amazonaws.com`, maxRetries: 0, maxRedirects: 0,
    credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN },
    httpOptions: { timeout: 8000, connectTimeout: 5000 }
  });
  const identity = await sts.getCallerIdentity({}).promise();
  if (!identity?.Account || !identity?.Arn) throw new Error("AWS caller identity could not be verified");
}

async function runConnectivityCheck(env = process.env) {
  assertSafeSwitches(env);
  const local = await verifyLocalConfiguration(env);
  const services = { ElevenLabs: "Skipped: non-billable metadata access not confirmed" };
  for (const [service, check] of [["Voice123", checkVoice123], ["GoogleSheets", checkGoogleSheets], ["AWSIdentity", checkAwsIdentity]]) {
    try {
      await check(env);
      services[service] = "Verified";
    } catch (error) {
      if (error?.code === "MODULE_NOT_FOUND") throw new Error("A read-only connectivity dependency is unavailable");
      services[service] = "Unverified";
    }
  }
  return { local, services };
}

if (require.main === module) {
  require("dotenv").config();
  runConnectivityCheck().then(result => {
    console.log(JSON.stringify(result, null, 2));
    if (Object.values(result.services).includes("Unverified")) process.exitCode = 1;
  }).catch(() => {
    console.error("Read-only connectivity preflight failed. No write or production fallback is available.");
    process.exitCode = 1;
  });
}

module.exports = { runConnectivityCheck, assertSafeSwitches };
