const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const puppeteer = require("puppeteer");
const projects = require("../voice123-projects");

const { ORIGIN, PROJECT_PATH, projectIdentity, projectLinks, readSpecs, auditionReadiness } = projects;
const url = id => ORIGIN + "/projects/" + id + "/example/specs";
const instruction = "Hello, please test according to the role description. Thank you,";
const copy = "The light over the harbor was still burning when we arrived just before dawn.";
let browser;
before(async () => { browser = await puppeteer.launch({ headless: true }); });
after(async () => { await browser?.close(); });

async function read(html, evaluate, ...args) {
  const page = await browser.newPage();
  try {
    await page.setOfflineMode(true);
    await page.setContent('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">' + html);
    return await page.evaluate(evaluate, ...args);
  } finally {
    await page.close();
  }
}

function specs(value, extras = "") {
  return `<main class="project-management specs">
    <div class="field-item">Project Description <div class="field-value-text">This copy is unrelated and must never be read.</div></div>
    <li class="field-item">
      <span>Get custom auditions</span><div class="field-value-text">Yes</div>
      <span>Script for custom audition</span><div><div class="vdl-expandable-text field-value-text">${value}</div></div>
      <span>Attachments</span>${extras}
    </li>
    <button>Accept Invite</button><input type="file"><p>1 proposal left</p>
  </main>`;
}

test("discovers visible canonical specs links and deduplicates IDs independent of URL slug", async () => {
  const found = await read(`
    <a href="${ORIGIN}/dashboard/invites">Invites</a>
    <a href="https://other.example/projects/FAKE/slug/specs">Untrusted</a>
    <a href="${url("HIDDEN")}" hidden>Hidden</a>
    <div role="listitem">Received invitation <a href="${url("ABC")}?private=example">New</a></div>
    <a href="${ORIGIN}/projects/abc/changed/specs#tab">Duplicate</a>
    <div role="listitem">Revision requested <a href="${url("REV")}">Revision</a></div>
    <a href="${url("OTHER")}">Unknown</a>
    <a href="${url("WRONG")}/more">Wrong route</a>`, projectLinks, ORIGIN, PROJECT_PATH.source);
  assert.deepEqual(found.map(project => [project.id, project.invitationStatus, project.url]), [
    ["ABC", "New invitation", url("ABC")], ["REV", "Revision requested", url("REV")], ["OTHER", "Unknown", url("OTHER")]
  ]);
  assert.equal(projectIdentity(found[0].url).id, "ABC");
});

test("validates the isolated live-shaped field without treating role directions or attachments as ready", async () => {
  const details = await read(specs(instruction, `
    <span><a href="/get?private=example"><span tabindex="0" title="表格.XLSX">表格.XLSX</span></a></span>
    <button title="notes.xls">Open</button><span role="button">copy.pdf</span>
    <a href="https://files.example/deliver%20copy.docx?opaque=example">Document</a><span data-filename="test.doc">Client file</span><span>voice.txt</span>
  `), readSpecs);
  assert.equal(details.fieldStatus, "Valid");
  assert.equal(details.fieldText, instruction);
  assert.equal(details.invitationStatus, "New invitation");
  assert.equal(details.proposalEligibility, "Unknown");
  assert.deepEqual(details.attachments.flatMap(attachment => attachment.types).sort(), ["DOC", "DOCX", "PDF", "TXT", "XLS", "XLSX"]);
  assert.equal(auditionReadiness(details, details.invitationStatus).status, "Needs Review");
  assert.equal(auditionReadiness({ ...details, attachments: [] }, details.invitationStatus).status, "Needs Review");
});

test("distinguishes missing, ambiguous, closed and ready audition material", async () => {
  const missing = await read('<main><div class="field-value-text">Description only</div></main>', readSpecs);
  assert.equal(missing.fieldStatus, "Missing");
  const ambiguous = await read(specs(copy + '<button>Expand</button>'), readSpecs);
  assert.equal(ambiguous.fieldStatus, "Needs Review");
  assert.equal(ambiguous.fieldText, null);
  const ready = await read(specs(copy), readSpecs);
  assert.equal(ready.proposalEligibility, "Unknown");
  assert.deepEqual(auditionReadiness(ready, "New invitation"), {
  status: "Needs Review",
  reason: "Proposal eligibility is not confirmed"
});

  const confirmedReady = { ...ready, proposalEligibility: "Yes" };
  assert.equal(auditionReadiness(confirmedReady, "New invitation").status, "Processing");
  assert.equal(auditionReadiness(ready, "Revision requested").status, "Needs Review");
  assert.equal(auditionReadiness(ready, "Unknown").status, "Needs Review");
  const closed = await read('<main><p role="status">This project is not accepting proposals.</p></main>', readSpecs);
  assert.equal(closed.proposalEligibility, "No");
  assert.equal(auditionReadiness({ ...ready, proposalEligibility: "No" }, "New invitation").status, "Needs Review");
  const open = await read('<main><p class="proposal-status">This project is accepting proposals.</p></main>', readSpecs);
  assert.equal(open.proposalEligibility, "Yes");
  const fallback = await read(`<main><dl><dt>Script for custom audition:</dt><dd>${copy}</dd></dl></main>`, readSpecs);
  assert.equal(fallback.fieldText, copy);
});

function production(overrides) {
  const filename = path.join(__dirname, "../voice123.js");
  const module = { exports: {} };
  const env = new Proxy({ HUMANIZE_TRAFFIC: "false", DRY_RUN: "false" }, {
    get: (values, key) => values[key] ?? (String(key).endsWith("_SELECTOR") ? ".fixture" : undefined)
  });
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module, URL, __dirname: path.dirname(filename), process: { env, pid: 1 },
    console: { log() {}, warn() {}, error() {} },
    require: key => key === "./worker-lock" ? { withWorkerLock: work => work() } :
      Object.hasOwn(overrides, key) ? overrides[key] : createRequire(filename)(key)
  }, { filename });
  return module.exports;
}

test("production discovery skips existing local and Sheets records before creating entries", async () => {
  const ids = ["LOCAL", "SHEET", "NEW"];
  const visits = [];
  const candidates = ids.map(id => ({ id, url: url(id), invitationStatus: "New invitation", title: id }));
  const history = [{ url: ORIGIN + "/projects/local/old-slug/specs" }];
  const added = [];
  let saved;
  const mockPage = () => {
    let current;
    const noop = async () => {};
    return {
      goto: async next => { current = next; visits.push(next); }, url: () => current,
      setViewport: noop, waitForSelector: noop, type: noop, waitForNavigation: noop, click: noop,
      waitForFunction: noop, close: noop,
      evaluate: async callback => callback === projectLinks ? candidates : callback === readSpecs ?
        { fieldStatus: "Valid", fieldText: instruction, attachments: [], proposalEligibility: "Unknown", invitationStatus: "New invitation" } : false
    };
  };
  const service = production({
    "./voice123-projects": projects,
    "./execution-permit": {
      openPermit: async () => ({ permit: { projectId: "NEW", trackingId: "record", id: "fixture" }, claim: async () => {}, validate: async () => {} }),
      discoveryClarification: async () => "a".repeat(64)
    },
    "./recovery-manifest": { createRecoveryAttempt: () => async () => {} },
    "./browser": { connect: async () => ({ newPage: async () => mockPage(), close: async () => {} }) },
    "./helpers": { safeQuerySelector: async () => "Description fixture" },
    "./googleSheets": {
      getProjectRecords: async () => [{ url: url("SHEET") }],
      addProject: async project => { added.push(project); return "record"; }
    },
    "fs-extra": {
      readJson: async () => history,
      writeJson: async (target, entries) => { saved = entries; },
      rename: async () => {}
    }
  });
  const result = await service.checkInvites({ dryRun: false });
  assert.deepEqual(visits.filter(visit => visit.includes("/projects/")), [url("NEW")]);
  assert.equal(result.length, 1);
  assert.equal(added[0].status, "Needs Review");
  assert.equal(added[0].script, null);
  assert.equal(added[0].auditionFieldText, instruction);
  assert.equal(added[0].description, "Description fixture");
  assert.equal(saved.length, 2);
});

test("normal generate entry point defaults to dry run and reports only planned actions", async () => {
  const noop = async () => {};
  const local = { id: "LOCAL", url: url("LOCAL"), title: "Local duplicate", invitationStatus: "New invitation" };
  const sheet = { id: "SHEET", url: url("SHEET"), title: "Sheets duplicate", invitationStatus: "New invitation" };
  const revision = { id: "REV", url: url("REV"), title: "Revision", invitationStatus: "Revision requested" };
  const visits = [];
  const unavailable = () => assert.fail("Dry run attempted a write or normal browser connection");
  const service = production({
    "./browser": { connect: unavailable },
    "./voice123-readonly": {
      connectReadOnly: async () => ({ close: noop }),
      readOnlyPage: async (browser, target) => ({
        url: () => target, goto: async () => { visits.push(target); },
        waitForFunction: noop, waitForSelector: noop, close: noop,
        evaluate: async callback => callback === projectLinks ? [local, sheet, revision, revision] :
          callback === readSpecs ? {
            fieldStatus: "Valid", fieldText: copy, attachments: [], rightsFlags: [],
            proposalEligibility: "Unknown", invitationStatus: "Unknown"
          } : false
      })
    },
    "./googleSheets": {
      getProjectRecords: async ({ readOnly }) => {
        assert.equal(readOnly, true);
        return [{ url: sheet.url }];
      },
      addProject: unavailable
    },
    "fs-extra": { readJson: async () => [{ url: local.url }], writeJson: unavailable, rename: unavailable }
  });
  const output = [];
  const module = { exports: {} };
  const filename = path.join(__dirname, "../main.js");
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module, process: { env: {} }, console: { log: message => output.push(JSON.parse(message)) },
    require: key => {
      if (key === "dotenv") return { config() {} };
      if (key === "./voice123") return service;
      return assert.fail("Unexpected workflow dependency " + key);
    }
  }, { filename });
  await module.exports();
  const [report] = output;
  assert.equal(report.dryRun, true);
  assert.deepEqual(visits.filter(visit => visit.includes("/projects/")), [local.url, sheet.url, revision.url]);
  assert.deepEqual(report.projects.map(project => project.duplicateSources), [["Local history"], ["Google Sheets"], []]);
  assert.deepEqual(report.projects.map(project => project.actions), [
    ["Skip existing processing record"], ["Skip existing processing record"],
    ["Create Google Sheets row with status Needs Review", "Append processing history"]
  ]);
  assert.equal(report.projects[2].invitationStatus, "Revision requested");
  assert.equal(report.projects[2].status, "Needs Review");
});

test("visible synthetic-voice rights require manual review even with a complete script", async () => {
  const details = await read(specs(copy).replace("</main>", "<p>Authorization for permanent use of synthetic voice data that can be sublicensed.</p></main>"), readSpecs);
  assert.deepEqual(details.rightsFlags, ["Permanent usage", "Voice-data sublicensing", "TTS or synthetic-voice authorization"]);
  assert.equal(details.fieldStatus, "Valid");
  assert.equal(auditionReadiness(details, "New invitation").status, "Needs Review");
});
