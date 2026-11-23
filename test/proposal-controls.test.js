const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const puppeteer = require("puppeteer");
const { inspectProposalPage } = require("../voice123-proposal-controls");

const pathname = "/projects/FIXTURE/fixture/specs";
const origin = "https://voice123.com";
const sibling = "proposal-hypothetical-sibling-controls.html";
const native = "proposal-hypothetical-native-form.html";
let browser;
before(async () => { browser = await puppeteer.launch({ headless: true }); });
after(async () => { await browser?.close(); });

async function inspect(filename, { modify = html => html, mode = "state", route = pathname, extension = ".mp3" } = {}) {
  const fixture = await fs.readFile(path.join(__dirname, "fixtures", filename), "utf8");
  const page = await browser.newPage();
  try {
    await page.setRequestInterception(true);
    page.on("request", request => {
      if (request.isNavigationRequest() && request.url() === origin + pathname) {
        return request.respond({
          status: 200, contentType: "text/html", body: modify(fixture), headers: { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" }
        });
      }
      return request.abort();
    });
    await page.goto(origin + pathname);
    return await page.evaluate(inspectProposalPage, route, mode, extension);
  } finally {
    await page.close();
  }
}

test("observed pre-accept sibling controls are recognized and blocked while disabled", async () => {
  assert.equal(await inspect("proposal-observed-pre-accept.html"), "disabled");
});

test("hypothetical post-accept fixtures allow only the verified control pair", async () => {
  assert.equal(await inspect(sibling), "ready");
  assert.equal(await inspect(native), "ready");
  assert.equal(await inspect(native, { extension: ".wav" }), "wrong-file-type");
  assert.equal(await inspect(sibling, { route: "/projects/OTHER/fixture/specs" }), "wrong-project");
  assert.equal(await inspect(sibling, { modify: html => html + '<input type="file" accept="audio/*">' }), "ready");
});

test("layout changes and unusable inputs and buttons fail closed", async () => {
  for (const [change, expected] of [
    [html => html.replace('id="submit"', 'id="other"'), "missing-or-ambiguous"],
    [html => html.replace('<input type="file"', '<input type="file" hidden'), "hidden"],
    [html => html.replace('id="submit"', 'id="submit" style="opacity:0"'), "hidden"],
    [html => html.replace('id="submit"', 'id="submit" aria-disabled="true"'), "disabled"],
    [html => html.replace('<input type="file"', '<input type="file" disabled'), "disabled"],
    [html => html.replace('<input type="file"', '<input type="file" form="post-offer-form"'), "wrong-form"],
    [html => html.replace("upload-box-container", "unknown-wrapper"), "unknown-layout"],
    [html => html.replace('<input type="file"', '<input type="file" accept="audio/*"><input type="file"'), "missing-or-ambiguous"],
    [html => html + '<button id="submit">Submit</button>', "missing-or-ambiguous"]
  ]) {
    assert.equal(await inspect(sibling, { modify: change }), expected);
  }
});

test("confirmation requires one visible, unambiguous success message in the current proposal panel", async () => {
  const status = '<p role="status">Your proposal was submitted successfully.</p>';
  const put = value => html => html.replace('<div class="result"></div>', value);
  for (const [change, result] of [
    [html => html, false],
    [put(status), true],
    [html => html + status, false],
    [put(status + status), false],
    [put(status + '<p role="alert">Submission failed.</p>'), false],
    [html => put(status)(html) + '<p role="alert">Submission failed.</p>', false],
    [put(status.replace("<p ", "<p hidden ")), false],
    [put('<p role="status">Draft saved.</p>'), false]
  ]) {
    assert.equal(await inspect(sibling, { mode: "confirmation", modify: change }), result);
  }
  assert.equal(await inspect(sibling, { mode: "existing-confirmation", modify: put(status) }), true);
  assert.equal(await inspect(sibling, { mode: "confirmation", route: "/projects/OTHER/fixture/specs", modify: put(status) }), false);
});
