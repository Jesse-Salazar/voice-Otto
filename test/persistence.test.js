const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { persistReviewProjects } = require("../persistence-test");
const { projectIdentity } = require("../voice123-projects");

const url = id => `https://voice123.com/projects/${id}/test/specs`;
const fixture = id => ({ id, url: url(id), status: "Needs Review", invitationStatus: "New invitation", title: id });
const first = fixture("INVQUDO70");
const second = fixture("INVQTR98G");
const revision = { ...fixture("IMQDVNNB0"), invitationStatus: "Revision requested" };
const historyPath = "/mock/processed-projects.json";
const report = (...projects) => ({ dryRun: true, sheetsCheck: "Checked", projects });

function mocks(history, append, failRename = false) {
  let content = JSON.stringify(history);
  let staged;
  const handles = new Map();
  const calls = [];
  return {
    calls,
    content: () => JSON.parse(content),
    options: {
      historyPath,
      sheets: { appendReviewProjects: async projects => {
        calls.push("append");
        return append(projects);
      } },
      files: {
        readFile: async () => content,
        open: async (name, flags) => {
          assert.equal(flags, "wx");
          assert.equal(handles.has(name), false);
          const handle = {
            close: async () => {},
            writeFile: async value => { staged = value; },
            sync: async () => {}
          };
          handles.set(name, handle);
          return handle;
        },
        rename: async (source, target) => {
          assert.equal(target, historyPath);
          if (failRename) throw new Error("Mock rename failure");
          content = staged;
        },
        unlink: async name => {
          assert.notEqual(name, historyPath);
          handles.delete(name);
        }
      }
    }
  };
}

test("persistence-only test appends two new review records and never touches the existing revision", async () => {
  const prior = [{ id: "prior", url: revision.url, status: "Uploaded", nested: { keep: true } }];
  const mock = mocks(prior, projects => {
    assert.deepEqual(projects.map(({ voice123Id, status, script }) => [voice123Id, status, script]), [
      [first.id, "Needs Review", null], [second.id, "Needs Review", null]
    ]);
    return projects.map((project, index) => ({ ...project, id: "row" + index }));
  });
  const result = await persistReviewProjects(report(first, second, revision), mock.options);
  assert.deepEqual(result.skipped, [{ voice123Id: revision.id, reason: "Outside test scope" }]);
  assert.deepEqual(mock.content().slice(0, 1), prior);
  assert.deepEqual(mock.content().slice(1).map(project => project.voice123Id), [first.id, second.id]);
  const rerun = await persistReviewProjects(report(first, second, revision), mock.options);
  assert.deepEqual(rerun.created, []);
  assert.deepEqual(mock.calls, ["append"]);
});

test("persistence rejects Processing, duplicate or unverified input before any write", async () => {
  const mock = mocks([], () => assert.fail("unexpected Sheets append"));
  for (const input of [report({ ...first, status: "Processing" }), report(first, first),
    { ...report(first), sheetsCheck: "Unavailable" }]) {
    await assert.rejects(persistReviewProjects(input, mock.options));
  }
  assert.deepEqual(mock.calls, []);
  assert.deepEqual(mock.content(), []);
});

test("a Sheets append followed by a history failure identifies the partial write", async () => {
  const mock = mocks([], projects => projects.map(project => ({ ...project, id: "row1" })), true);
  await assert.rejects(persistReviewProjects(report(first), mock.options), /INVQUDO70\/row1.*Reconcile/);
  assert.deepEqual(mock.content(), []);
});

test("Sheets writer rechecks duplicates, validates columns and uses raw row insertion", async () => {
  const headers = ["Project ID", "Project Title", "Project URL", "Deadline", "Script", "Status",
    "Processed At", "Client ID", "Audio File URL"];
  const existing = [{ get: key => ({ "Project URL": first.url, "Project ID": "prior" })[key] }];
  const calls = [];
  const sheet = {
    getRows: async () => existing, headerValues: headers,
    addRows: async (rows, options) => calls.push(JSON.parse(JSON.stringify({ rows, options })))
  };
  const dependencies = {
    "google-spreadsheet": { GoogleSpreadsheet: class {
      sheetsByIndex = [sheet];
      async loadInfo() {}
    } },
    "google-auth-library": { JWT: class {} },
    dotenv: { config() {} },
    uuid: { v4: () => "12345678-mocked" },
    "./voice123-projects": { projectIdentity },
    "./helpers": { retry: callback => callback() }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../googleSheets.js"), "utf8"), {
    module, process: { env: { GOOGLE_SHEET_ID: "mock", GOOGLE_SERVICE_ACCOUNT_EMAIL: "mock", GOOGLE_PRIVATE_KEY: "mock" } },
    require: key => dependencies[key]
  });
  const projects = [first, second].map(project => ({ ...project, voice123Id: project.id, script: null }));
  const created = await module.exports.appendReviewProjects(projects);
  assert.equal(created.length, 1);
  assert.equal(created[0].voice123Id, second.id);
  assert.deepEqual(calls[0].options, { raw: true, insert: true });
  assert.equal(calls[0].rows[0].Status, "Needs Review");
  assert.equal(calls[0].rows[0].Script, "MANUAL_REVIEW_REQUIRED");
  assert.equal(calls[0].rows[0]["Audio File URL"], "");
  headers.pop();
  await assert.rejects(module.exports.appendReviewProjects(projects), /Missing Sheets columns: Audio File URL/);
  assert.equal(calls.length, 1);
});
