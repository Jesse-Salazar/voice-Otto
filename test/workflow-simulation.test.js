const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const fs = require("node:fs/promises");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const crypto = require("node:crypto");
const puppeteer = require("puppeteer");
const projects = require("../voice123-projects");
const evidence = require("../approval-evidence");
const { extractAttachment } = require("../attachment-review");
const clarification = require("../clarification-log");
const recovery = require("../recovery-manifest");
const permits = require("../execution-permit");
const { inspectProposalPage } = require("../voice123-proposal-controls");
const { PassThrough, Writable } = require("node:stream");

const id = "SYNTH10A";
const trackingId = "synthetic-tracking";
const target = `https://voice123.com/projects/${id}/offline-fixture/specs`;
const dashboard = "https://voice123.com/dashboard/invites";
const login = "https://accounts.voice123.com/signin/";
const dummyAudio = Buffer.concat(Array.from({ length: 3 }, () => {
  const frame = Buffer.alloc(417);
  Buffer.from("fffb9064", "hex").copy(frame);
  return frame;
}));
const dummyHash = evidence.sha256(dummyAudio);
const syntheticTerms = "Synthetic specs for simulation, version one.";
const syntheticAgreement = "Synthetic TTS terms, version one. This is only a test.";
const plain = value => JSON.parse(JSON.stringify(value));
const version = (number, data) => ({ version: number, sha256: evidence.sha256(data) });
const source = (filename, number, data) => ({ filename, ...version(number, data) });
const noop = async () => {};
let chrome;
let parsedList;
let parsedSpecs;
before(async () => {
  chrome = await puppeteer.launch({ headless: true });
  const page = await chrome.newPage();
  try {
    await page.setOfflineMode(true);
    const render = html => page.setContent('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">' + html);
    await render(`<ul><li>Received invitation <a href="${target}">Synthetic TTS audition</a></li>
      <li><a href="${target}?duplicate=1">Duplicate</a></li></ul>`);
    parsedList = await page.evaluate(projects.projectLinks, projects.ORIGIN, projects.PROJECT_PATH.source);
    await render(`<main class="project-management specs">
      <div class="field-item"><span>Script for custom audition</span><div class="field-value-text">See attached script.</div></div>
      <div class="field-item"><a href="/fixture/audition.txt">audition.txt</a></div>
      <div class="field-item">Authorization for permanent synthetic voice data use and sublicensing.</div>
      <button>Accept Invite</button></main>`);
    parsedSpecs = await page.evaluate(projects.readSpecs);
  } finally {
    await page.close();
  }
});
after(async () => { await chrome?.close(); });

async function simulator(t, { attended = false } = {}) {
  const id = attended ? "SYNTH11BREHEARSAL" : "SYNTH10A";
  const target = `https://voice123.com/projects/${id}/offline-fixture/specs`;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), attended ? "voice-otto-issuance-" : "voice-otto-e2e-synthetic-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sources = path.join(directory, "sources");
  const projectDirectory = path.join(sources, id);
  const historyFile = path.join(directory, "processed-projects.json");
  const recoveryDirectory = path.join(await fs.realpath(directory), "recovery");
  const permitDirectory = path.join(await fs.realpath(directory), "permits");
  const journal = path.join(directory, "clarifications.jsonl");
  const reviewFile = path.join(directory, "review.json");
  const audioFile = path.join(directory, "reviewed.mp3");
  const file = path.join(projectDirectory, "audition.txt");
  const putSource = (name, bytes) => fs.writeFile(path.join(projectDirectory, name), bytes);
  await fs.mkdir(projectDirectory, { recursive: true });
  await putSource("audition.txt", "Instructions: Use a soft voice.\nRecording script\nA lantern keeps the shore visible.\nThe tide is turning.\n");
  await putSource("terms.txt", syntheticTerms);
  await putSource("agreement.txt", syntheticAgreement);
  const extraction = await extractAttachment(file);
  const script = extraction.sections.flatMap(section => section.blocks.flatMap(block =>
    block.lines.filter(line => line.kind === "dialogue-candidate").map(line => line.text))).join("\n");
  const registry = [{ id, title: "Synthetic TTS audition", threads: [{ source: "simulation", id: "synthetic-thread" }] }];
  const append = item => clarification.appendClarification(journal, {
    source: "simulation", threadId: "synthetic-thread", timestamp: new Date().toISOString(), ...item
  }, registry);
  const message = (messageId, direction, text) => ({
    kind: "message", messageId, direction, text,
    sender: { id: direction === "inbound" ? "synthetic-client" : "synthetic-reviewer", verification: "verified" },
    recipient: { id: direction === "inbound" ? "synthetic-reviewer" : "synthetic-client", verification: "verified" }
  });
  const receive = (messageId = "fixture-inbound", extra = {}) => append({
    ...message(messageId, "inbound", "Please record both lines, one take."), ...extra
  });

  const options = { journal, sources, attachmentDirectory: sources, historyFile };
  const api = {
    ...evidence,
    readCurrentClarification: row => evidence.readCurrentClarification(row, options),
    verifyCurrentProjectReview: (row, review) => evidence.verifyCurrentProjectReview(row, review, options)
  };
  const env = { DRY_RUN: "false", HUMANIZE_TRAFFIC: "false", ENABLE_PAID_GENERATION: "true",
    ENABLE_VOICE123_SUBMISSION: "true", SAVE_LOCAL_AUDIO: "false", ELEVENLABS_VOICE_ID: "synthetic-voice",
    AWS_REGION: "us-east-1", AWS_BUCKET_NAME: "fixture-audio-bucket" };
  const events = [];
  const issued = [];
  const controls = { approved: true, confirmation: true };
  let row;
  let reviewer;
  let published;
  let attached;
  let accepted = false;
  let heldByMock = false;
  const mockedLock = {
    withWorkerLock: async action => {
      if (heldByMock) throw new Error("Synthetic lock is held");
      heldByMock = true;
      try { return await action(); } finally { heldByMock = false; }
    }
  };
  const columnNames = { Status: "status", Script: "script", "Approval Evidence": "evidence", "Reviewed At": "reviewedAt",
    "Audio File URL": "audioUrl", "Voice Settings": "voiceSettings", "Uploaded At": "uploadedAt", Notes: "notes" };
  const sheets = {
    getProjectRecords: async () => row ? [plain(row)] : [],
    addProject: async project => {
      assert.equal(row, undefined);
      assert.equal(project.voice123Id, id);
      assert.equal(project.status, "Needs Review");
      row = { ...plain(project), id: trackingId, script: "MANUAL_REVIEW_REQUIRED" };
      events.push({ action: "discovered", id, status: row.status });
      return trackingId;
    },
    getProjectsByStatus: async status => row?.status === status ? [{
      id: row.id, url: row.url, audioFileName: row.audioUrl?.split("/").at(-1)
    }] : [],
    getApprovalProject: async query => {
      assert.ok(query.id === trackingId || query.voice123Id === id, "Unexpected project lookup");
      return plain(row);
    },
    updateProject: async (ref, changes, expected) => {
      assert.equal(ref, trackingId);
      if (expected) assert.deepEqual(plain(expected), row, "Stale mocked Sheets write");
      const values = plain(changes);
      await controls.onSheetUpdate?.(values);
      row = { ...row, ...Object.fromEntries(Object.entries(values).map(([key, value]) => [columnNames[key] || key, value])) };
      events.push({ action: "sheet-update", changes: values });
    }
  };

  const fakeBrowser = {
    connect: async () => ({
      newPage: async () => {
        let current;
        return {
          goto: async url => {
            assert.ok([target, dashboard, login].includes(url), "Unexpected synthetic navigation");
            current = url;
          },
          url: () => current, setViewport: noop, click: noop, type: noop, waitForNavigation: noop,
          waitForSelector: noop, waitForFunction: noop, close: noop,
          evaluate: async callback => callback === projects.projectLinks ?
            parsedList.map(project => ({ ...project, id, url: target })) : callback === projects.readSpecs ? parsedSpecs : false
        };
      },
      close: noop
    })
  };
  const storage = {
    uploadFile: async (bytes, key, mime) => {
      assert.equal(evidence.sha256(bytes), dummyHash);
      assert.equal(mime, "audio/mpeg");
      events.push({ action: "storage-put", key, sha256: evidence.sha256(bytes) });
      await controls.onStorage?.();
      published = { key, bytes: Buffer.from(bytes) };
      await controls.afterStorage?.();
      return { $metadata: { httpStatusCode: controls.storageStatus ?? 200 } };
    },
    downloadFile: async key => {
      assert.equal(key, published.key);
      events.push({ action: "storage-get", key });
      await controls.onDownload?.();
      return Buffer.from(published.bytes);
    }
  };
  const mockFetch = async (url, request) => {
    assert.equal(new URL(url).origin, "https://api.elevenlabs.io");
    assert.equal(request.method, "POST");
    assert.equal(JSON.parse(request.body).text, script);
    assert.equal(request.headers["xi-api-key"], undefined);
    events.push({ action: "generation-call" });
    await controls.onGeneration?.();
    if (controls.httpFailure) return { ok: false, status: 503 };
    return { ok: true, arrayBuffer: async () => controls.emptyAudio ? Buffer.alloc(0) : dummyAudio };
  };

  const mockedOs = { tmpdir: () => directory, userInfo: () => ({ username: reviewer }) };
  const approvedModules = {
    "node:path": path, "path": path, "node:os": mockedOs, "node:fs/promises": fs,
    "node:crypto": crypto, "node:util": { promisify: require("node:util").promisify },
    "node:child_process": { execFile: () => assert.fail("Unexpected process from approval CLI") },
    dotenv: { config() {} }, inquirer: { prompt: async prompts => {
      events.push({ action: "human-decision", reviewer, prompt: prompts[0].message, approved: controls.approved });
      return { confirmed: controls.approved };
    } },
    "./googleSheets": sheets, "./s3": storage, "./browser": fakeBrowser, "./validateEnv": () => {},
    "./helpers": { waitFor: noop, safeQuerySelector: async () => "Synthetic project description" },
    "./worker-lock": mockedLock, "./voice123-projects": projects, "./approval-evidence": api,
    "./voice123-readonly": {
      connectReadOnly: fakeBrowser.connect,
      readOnlyPage: async browser => browser.newPage()
    },
    "./execution-permit": {
      approvalBinding: permits.approvalBinding,
      openPermit: operation => permits.openPermit(operation, { permitId: env.VOICE_OTTO_PERMIT_ID, directory: permitDirectory }),
      discoveryClarification: async projectId => (await clarification.readClarifications(journal))
        .findLast(record => record.event.projectId === projectId)?.hash ?? evidence.fingerprint([])
    },
    "./recovery-manifest": { createRecoveryAttempt: context => recovery.createRecoveryAttempt(context, recoveryDirectory) },
    "@aws-sdk/client-s3": {
      S3Client: class {
        async send(command) { return storage.uploadFile(command.input.Body, command.input.Key, command.input.ContentType); }
        destroy() {}
      },
      PutObjectCommand: class { constructor(input) { this.input = input; } }
    },
    "@aws-sdk/credential-provider-env": { fromEnv: () => () => assert.fail("AWS credentials requested in simulation") },
    "./voice123-proposal-controls": { inspectProposalPage }
  };
  approvedModules["fs-extra"] = {
    readJson: async name => { assert.equal(name, historyFile); return JSON.parse(await fs.readFile(name, "utf8")); },
    writeJson: async (name, data) => {
      assert.equal(name, historyFile + ".777.tmp");
      await fs.writeFile(name, JSON.stringify(data), { flag: "wx" });
    },
    rename: async (from, to) => { assert.equal(to, historyFile); await fs.rename(from, to); },
    ensureDir: () => assert.fail("Local production audio path was accessed"),
    writeFile: () => assert.fail("Local production audio path was accessed")
  };
  const cache = new Map();
  function load(name) {
    if (cache.has(name)) return cache.get(name);
    const filename = path.join(__dirname, "..", name);
    const module = { exports: {} };
    vm.runInNewContext(readFileSync(filename, "utf8"), {
      module, __dirname: directory, Buffer, URL,
      process: { env, pid: 777, argv: [], stdin: { isTTY: true }, stdout: { isTTY: true } },
      console: { log() {}, warn() {}, error() {} },
      fetch: name === "elevenlabs.js" ? mockFetch : () => assert.fail("Unexpected fetch"),
      require: key => {
        assert.ok(Object.hasOwn(approvedModules, key), "Unmocked dependency: " + key);
        return approvedModules[key];
      }
    }, { filename });
    cache.set(name, module.exports);
    return module.exports;
  }
  approvedModules["./approval-audio"] = {
    stageAudio: async filename => {
      await controls.onStage?.();
      assert.ok(path.resolve(filename).startsWith(directory + path.sep), "Audio escaped synthetic directory");
      return load("approval-audio.js").stageAudio(filename);
    }
  };
  approvedModules["./elevenlabs"] = load("elevenlabs.js");
  const uploadPage = {
    goto: async url => assert.equal(url, target), url: () => target,
    evaluate: async (callback, pathname, mode) => {
      assert.equal(callback, inspectProposalPage);
      return mode === "state" ? accepted ? "ready" : "disabled" : false;
    },
    $$: async () => accepted ? [] : [{
      evaluate: async fn => fn.toString().includes("innerText") ? "Accept Invite" : true,
      click: async () => { accepted = true; events.push({ action: "mock-accept" }); }
    }],
    evaluateHandle: async () => ({
      dispose: noop,
      getProperty: async key => ({
        dispose: noop, jsonValue: async () => accepted ? "ready" : "disabled",
        asElement: () => key === "input" ? {
          uploadFile: async filename => {
            assert.ok(filename.startsWith(directory + path.sep));
            attached = evidence.sha256(await fs.readFile(filename));
            events.push({ action: "mock-attach", sha256: attached });
            await controls.afterAttachment?.();
          },
          evaluate: async () => attached
        } : {
          click: async () => {
            assert.equal(row.status, "Submission Uncertain");
            events.push({ action: "mock-submit" });
          }
        }
      })
    }),
    waitForFunction: async () => controls.confirmation
  };
  approvedModules["./voice123-submission"] = {
    submitApprovedAudio: (url, filename) => load("voice123-submission.js").submitApprovedAudio(url, filename, {
      connect: async () => {
        events.push({ action: "mock-submit-browser" });
        return { newPage: async () => uploadPage, close: noop };
      },
      handleLogin: noop
    })
  };
  approvedModules["./voice123"] = load("voice123.js");

  async function issue(operation, binding, fixtureRow = row) {
    let permit;
    if (attended) {
      const account = os.userInfo();
      const authorization = `rehearsal-${operation}`;
      const now = Date.now();
      await fs.writeFile(path.join(directory, "authorizations.json"), JSON.stringify([{
        reference: authorization, uid: account.uid, operator: account.username, projectId: id, trackingId,
        operation, status: "active", createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 600_000).toISOString()
      }]), { mode: 0o600 });
      await fs.writeFile(path.join(directory, "projects.json"), JSON.stringify([{
        ...fixtureRow, generationInputs: approvedModules["./elevenlabs"].generationInputs(), stagedAudio: path.basename(audioFile)
      }]), { mode: 0o600 });
      const input = new PassThrough();
      let prompted = false;
      const output = new Writable({ write(chunk, encoding, done) {
        if (!prompted && chunk.toString().includes("to issue the synthetic permit:")) {
          prompted = true;
          setImmediate(() => input.write(`ISSUE ${id} ${operation}\n`));
        }
        done();
      } });
      input.isTTY = output.isTTY = true;
      permit = await permits.runInteractiveIssuance(["--workspace", directory, "--project", id, "--tracking", trackingId,
        "--operation", operation, "--authorization", authorization, "--minutes", "2",
        ...(operation === "submission" ? ["--audio-sha256", dummyHash] : [])], { input, output });
      for (const [key, value] of Object.entries(binding)) assert.equal(permit[key], value ?? null);
    } else permit = await permits.issuePermit({
      ...binding, operation, operator: "synthetic-reviewer", authorization: "offline fixture authorization",
      expiresAt: new Date(Date.now() + 600000).toISOString()
    }, { directory: permitDirectory });
    env.VOICE_OTTO_PERMIT_ID = permit.id;
    issued.push(permit);
  }
  async function approve(stage, ...args) {
    reviewer = stage + "-synthetic-reviewer";
    await load("approval.js")([stage, trackingId, new Date(Date.now() + 3_600_000).toISOString(), ...args]);
    if (stage === "generation" && row.status === "Generation Approved") {
      await issue("generation", permits.approvalBinding(row));
    }
    if (stage === "submission" && row.status === "Submission Approved") {
      await issue("submission", permits.approvalBinding(row, dummyHash));
    }
  }
  async function reviewMaterials(latest) {
    const material = await append({
      kind: "project-material", reviewer: "source-synthetic-reviewer", verifiedSource: "synthetic terms and agreement",
      reviewedThrough: latest.record.hash, script: version("1", script), terms: source("terms.txt", "1", syntheticTerms),
      agreementRequired: true, agreement: source("agreement.txt", "1", syntheticAgreement),
      attachments: [{ filename: "audition.txt", version: "1", sha256: extraction.provenance.sha256 }]
    });
    const review = {
      script, clarificationSnapshotHash: material.record.hash,
      attachmentReview: { outcome: "reviewed", reason: "Both candidate lines manually selected for the synthetic audition",
        sources: [extraction.provenance] },
      revisionReview: { outcome: "new invitation", reason: "Synthetic invitation checked" },
      rights: Object.fromEntries(evidence.rights.map(right => [right, { outcome: "cleared", reason: "Synthetic human agreement review" }]))
    };
    await fs.writeFile(reviewFile, JSON.stringify(review), { mode: 0o600 });
    return review;
  }
  async function prepareReview() {
    const exchange = async () => {
      await append(message("fixture-outbound", "outbound", "How many takes and which lines?"));
      const latest = await receive();
      assert.equal(latest.record.event.reviewStatus, "Needs Review");
      return reviewMaterials(latest);
    };
    const review = attended ? await exchange() : null;
    const preview = (await approvedModules["./voice123"].checkInvites({ dryRun: true })).projects[0];
    let fixtureRow;
    if (attended) {
      const candidate = parsedList[0];
      const plan = { voice123Id: id, title: candidate.title, url: target, deadline: candidate.deadline,
        invitationStatus: preview.invitationStatus, proposalEligibility: parsedSpecs.proposalEligibility,
        auditionFieldStatus: parsedSpecs.fieldStatus, auditionFieldText: parsedSpecs.fieldText,
        attachments: parsedSpecs.attachments, rightsFlags: parsedSpecs.rightsFlags || [],
        reviewReason: preview.reason, status: "Needs Review", script: null,
        description: "No description", clientId: "No client ID" };
      assert.equal(evidence.fingerprint(plan), preview.discoveryApprovalSha256, "Fixture matches the exact dry-run plan");
      const change = evidence.transition({ id: trackingId, url: target }, "project", {
        ...review, clarification: await clarification.currentProjectMaterial(journal, id),
        reviewer: "pre-discovery-synthetic-reviewer", expiresAt: new Date(Date.now() + 600_000).toISOString()
      });
      fixtureRow = { id: trackingId, url: target, script, status: "Pending Discovery", discoveryPlan: plan,
        evidence: change["Approval Evidence"] };
    }
    await issue("discovery", { projectId: id, trackingId, approvalSha256: preview.discoveryApprovalSha256,
      clarificationSha256: preview.discoveryClarificationSha256 }, fixtureRow);
    await load("main.js")();
    assert.equal(row.status, "Needs Review");
    return review || exchange();
  }
  async function prepareGeneration() {
    await prepareReview();
    await approve("project", reviewFile);
    await approve("generation");
  }
  async function prepareSubmission() {
    await prepareGeneration();
    await load("main.js")();
    assert.equal(row.status, "Pending Submission Approval");
    await fs.writeFile(audioFile, published.bytes, { mode: 0o600 });
    await approve("submission", audioFile);
    assert.equal(row.status, "Submission Approved");
  }
  return { directory, permitDirectory, issued, file, audioFile, reviewFile, historyFile, journal, events, controls, env, extraction, script,
    append, receive, putSource, prepareReview, prepareGeneration, prepareSubmission, approve, load,
    recovery: async () => (await recovery.readRecoveryAttempts(recoveryDirectory)).map(attempt => recovery.classifyRecovery(attempt)),
    row: () => plain(row), edit: changes => { row = { ...row, ...changes }; },
    generate: () => approvedModules["./elevenlabs"].generateAudio(trackingId, row.script),
    submit: () => approvedModules["./voice123"].uploadAudio(row.url, audioFile),
    status: () => row.status,
    counts: action => events.filter(event => event.action === action).length
  };
}

test("interactive permits complete all three mocked scopes and link issuance, claim and recovery", async t => {
  const run = await simulator(t, { attended: true });
  await run.prepareReview();
  assert.equal(run.status(), "Needs Review");
  assert.equal(run.row().evidence, undefined);
  await assert.rejects(run.load("main.js")(), /consumed/);
  await run.approve("project", run.reviewFile);
  await run.approve("generation");
  await run.load("main.js")();
  assert.equal(run.status(), "Pending Submission Approval");
  await assert.rejects(run.load("main.js")(), /consumed/);
  await fs.writeFile(run.audioFile, dummyAudio, { mode: 0o600 });
  await run.approve("submission", run.audioFile);
  await run.load("upload.js")();
  assert.equal(run.status(), "Uploaded");
  await assert.rejects(run.load("upload.js")(), /consumed/);

  const attempts = await run.recovery();
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts.map(record => record.finding).sort(), ["discovery-persisted", "published", "submitted-and-audited"]);
  for (const permit of run.issued) {
    const read = async suffix => JSON.parse(await fs.readFile(path.join(run.permitDirectory, permit.id + suffix), "utf8"));
    const audit = await read(".issued");
    const claim = await read(".claim");
    const anchor = JSON.parse(await fs.readFile(path.join(run.directory, permit.id + ".consumed"), "utf8"));
    assert.deepEqual(anchor, claim);
    const attempt = attempts.find(record => record.operation === permit.operation);
    assert.equal(audit.permitId, claim.permitId);
    assert.equal(claim.permitId, attempt.permitId);
    assert.equal(claim.attemptId, attempt.attemptId);
    assert.equal(audit.projectId, attempt.projectId);
    assert.equal(audit.trackingId, attempt.trackingId);
    assert.equal(audit.summary.operationBindingSha256, attempt.approvalSha256);
    assert.equal(audit.summary.clarificationSha256, attempt.clarificationSnapshotHash);
  }
  for (const action of ["discovered", "generation-call", "storage-put", "mock-submit"]) assert.equal(run.counts(action), 1);
});

test("synthetic invitation completes discovery, clarification, independent approval, generation, staging and confirmed submission", async t => {
  const run = await simulator(t);
  const proposal = await run.prepareReview();
  assert.equal(run.extraction.status, "Needs Review");
  assert.equal(run.extraction.candidateLines, 2);
  assert.equal(run.row().status, "Needs Review");
  assert.equal(run.row().evidence, undefined);
  assert.equal(run.counts("discovered"), 1);
  const entries = (await clarification.readClarifications(run.journal)).map(record => record.event);
  assert.deepEqual(entries.map(event => event.kind), ["message", "message", "project-material"]);
  assert.deepEqual(entries.slice(0, 2).map(event => event.direction), ["outbound", "inbound"]);
  assert.equal((await run.receive("fixture-inbound", { timestamp: entries[1].timestamp })).appended, false);
  await assert.rejects(run.generate(), /permit (?:operation|is consumed)/g);
  run.controls.approved = false;
  await run.approve("project", run.reviewFile);
  assert.equal(run.status(), "Needs Review");

  run.controls.approved = true;
  await fs.writeFile(run.reviewFile, JSON.stringify({ ...proposal, rights: {} }));
  await assert.rejects(run.approve("project", run.reviewFile), /required project review/);
  await fs.writeFile(run.reviewFile, JSON.stringify(proposal));
  await run.approve("project", run.reviewFile);
  assert.equal(run.status(), "Project Reviewed");
  assert.equal(run.row().script, run.script);
  await assert.rejects(run.generate(), /permit (?:operation|is consumed)/g);
  await run.approve("generation");
  assert.equal(run.status(), "Generation Approved");

  await run.load("main.js")();
  assert.equal(run.status(), "Pending Submission Approval");
  assert.equal(run.counts("generation-call"), 1);
  assert.equal(run.counts("storage-put"), 1);
  await fs.writeFile(run.audioFile, dummyAudio);
  await assert.rejects(run.submit(), /permit (?:operation|is consumed)/g);
  assert.equal(run.counts("mock-submit-browser"), 0);
  await run.approve("submission", run.audioFile);
  assert.equal(run.status(), "Submission Approved");
  const saved = evidence.parseEvidence(run.row());
  assert.equal(saved.voice123Id, id);
  assert.equal(saved.trackingId, trackingId);
  assert.equal(saved.submission.audioSha256, dummyHash);
  assert.deepEqual([saved.project.reviewer, saved.generation.reviewer, saved.submission.reviewer],
    ["project-synthetic-reviewer", "generation-synthetic-reviewer", "submission-synthetic-reviewer"]);
  assert.throws(() => evidence.authorizeSubmission({
    ...run.row(), url: "https://voice123.com/projects/OTHERSYNTH/other-fixture/specs"
  }, dummyHash), /identity/);

  await run.load("upload.js")();
  assert.equal(run.status(), "Uploaded");
  assert.ok(Date.parse(run.row().uploadedAt));
  assert.equal(run.events.find(event => event.action === "mock-attach").sha256, dummyHash);
  assert.deepEqual(run.events.filter(event => event.action === "sheet-update" && event.changes.Status).map(event => event.changes.Status),
    ["Project Reviewed", "Generation Approved", "Processing", "Pending Submission Approval",
      "Submission Approved", "Submission Uncertain", "Uploaded"]);
  assert.equal(JSON.parse(await fs.readFile(run.historyFile, "utf8")).length, 1);

  await assert.rejects(run.load("main.js")(), /consumed/);
  await assert.rejects(run.load("upload.js")(), /consumed/);
  await assert.rejects(run.submit(), /permit (?:operation|is consumed)/g);
  assert.equal(run.counts("discovered"), 1);
  assert.equal(run.counts("generation-call"), 1);
  assert.equal(run.counts("mock-submit"), 1);
  assert.deepEqual((await run.recovery()).map(entry => entry.finding).sort(), ["discovery-persisted", "published", "submitted-and-audited"]);
});

for (const [label, inject, pattern] of [
  ["attachment bytes changed after project review", run => fs.appendFile(run.file, "\n"), /Attachment evidence.*changed/],
  ["new clarification after approval", run => run.receive("later-inbound"), /fresh project review/],
  ["agreement bytes changed before generation", run => run.putSource("agreement.txt", "changed synthetic agreement"), /terms or agreement bytes changed/],
  ["script changed after generation approval", async run => run.edit({ script: run.script + " Changed." }), /Recording script or required/],
  ["journal was corrupted", async run => {
    const bytes = await fs.readFile(run.journal, "utf8");
    await fs.writeFile(run.journal, bytes.replace("source-synthetic-reviewer", "tampered-reviewer"));
  }, /integrity check failed/],
  ["journal was truncated", async run => {
    const bytes = await fs.readFile(run.journal, "utf8");
    await fs.writeFile(run.journal, bytes.split("\n").slice(0, 2).join("\n") + "\n");
  }, /checkpoint/],
  ["legacy evidence version", async run => {
    run.edit({ evidence: JSON.stringify({ ...evidence.parseEvidence(run.row()), version: 1 }) });
  }, /version needs a fresh project review/],
  ["generation approval revoked", async run => {
    const stored = evidence.parseEvidence(run.row());
    stored.generation.decision = "revoked";
    run.edit({ evidence: JSON.stringify(stored) });
  }, /revoked/],
  ["worker interrupted with a persisted Processing claim", async run => run.edit({ status: "Processing" }), /exact reviewed recording script/]
]) {
  test(`direct generation blocks when ${label}`, async t => {
    const run = await simulator(t, { attended: ["new clarification after approval", "generation approval revoked"].includes(label) });
    await run.prepareGeneration();
    await inject(run);
    const hadStatus = run.status();
    await assert.rejects(run.generate(), pattern);
    assert.equal(run.status(), hadStatus);
    assert.equal(run.counts("generation-call"), 0);
    assert.equal(run.counts("storage-put"), 0);
  });
}

test("unknown project and ambiguous recipient block preparation of approval evidence", async t => {
  const run = await simulator(t);
  await run.prepareReview();
  await assert.rejects(run.receive("foreign", { observedProjectId: "ANOTHERSYNTH" }), /observed project ID/);
  const record = await run.receive("ambiguous", { recipient: { verification: "ambiguous" } });
  assert.equal(record.record.event.reviewStatus, "Identity Unverified");
  const material = (await clarification.readClarifications(run.journal)).find(entry => entry.event.kind === "project-material").event;
  await assert.rejects(run.append({ ...material, reviewedThrough: record.record.hash }), /Unresolved sender or recipient/);
  await assert.rejects(run.approve("project", run.reviewFile), /fresh project review/);
  assert.equal(run.row().evidence, undefined);
  assert.equal(run.status(), "Needs Review");
});

for (const [label, inject, status, errorPattern, storageCalls] of [
  ["generation interrupted", run => { run.controls.onGeneration = () => { throw new Error("mock generation interrupted"); }; }, "Processing", /interrupted/, 0],
  ["provider response failed", run => { run.controls.httpFailure = true; }, "Processing", /HTTP 503/, 0],
  ["provider returned empty audio", run => { run.controls.emptyAudio = true; }, "Processing", /empty file/, 0],
  ["storage interrupted", run => { run.controls.onStorage = () => { throw new Error("mock storage interrupted"); }; }, "Processing", /storage interrupted/, 1],
  ["storage returned no usable confirmation", run => { run.controls.storageStatus = 503; }, "Processing", /did not confirm staging/, 1],
  ["clarification arrived during generation", run => { run.controls.onGeneration = () => run.receive("during-generation"); },
    "Processing", /fresh project review/, 0],
  ["clarification arrived during staging", run => { run.controls.afterStorage = () => run.receive("during-staging"); },
    "Processing", /fresh project review/, 1]
]) {
  test(`in-flight generation stops safely when ${label}`, async t => {
    const run = await simulator(t, { attended: label === "generation interrupted" });
    await run.prepareGeneration();
    inject(run);
    await assert.rejects(run.generate(), errorPattern);
    assert.equal(run.status(), status);
    assert.equal(run.counts("generation-call"), 1);
    assert.equal(run.counts("storage-put"), storageCalls);
    assert.equal(run.row().audioUrl, "");
    const generation = (await run.recovery()).filter(entry => entry.operation === "generation");
    assert.ok(generation.every(entry => entry.manualReconciliation && !entry.automaticRetryAllowed));
    assert.ok(run.row().notes.includes(generation[0].attemptId));
    if (label === "clarification arrived during staging") {
      assert.ok((await run.recovery()).some(entry => entry.finding === "staged-orphan-candidate"));
    }
    await assert.rejects(run.load("main.js")(), /consumed/);
    assert.equal(run.counts("generation-call"), 1);
    assert.equal(run.counts("mock-submit"), 0);
  });
}

for (const [label, inject, pattern] of [
  ["voice changed before submission", async run => { run.env.ELEVENLABS_VOICE_ID = "changed-synthetic-voice"; }, /changed/],
  ["model changed before submission", async run => { run.env.ELEVENLABS_MODEL_ID = "changed-synthetic-model"; }, /changed/],
  ["audio bytes changed after submission approval", run => fs.appendFile(run.audioFile, "changed"), /audio bytes/],
  ["private audio staging failed", async run => { run.controls.onStage = () => { throw new Error("mock local staging failed"); }; }, /local staging failed/]
]) {
  test(`direct submission blocks when ${label}`, async t => {
    const run = await simulator(t);
    await run.prepareSubmission();
    await inject(run);
    await assert.rejects(run.submit(), pattern);
    assert.equal(run.status(), "Submission Approved");
    assert.equal(run.counts("mock-submit-browser"), 0);
    assert.equal(run.counts("mock-submit"), 0);
  });
}

test("failed storage retrieval never opens the submission browser", async t => {
  const run = await simulator(t);
  await run.prepareSubmission();
  run.controls.onDownload = () => { throw new Error("mock storage unavailable"); };
  await assert.rejects(run.load("upload.js")(), /storage unavailable/);
  assert.equal(run.status(), "Submission Approved");
  assert.equal(run.counts("mock-submit-browser"), 0);
  assert.equal(run.counts("storage-get"), 1);
});

test("missing storage configuration blocks paid generation before starting an attempt", async t => {
  const run = await simulator(t);
  await run.prepareGeneration();
  run.env.AWS_BUCKET_NAME = "";
  await assert.rejects(run.generate(), /invalid storage reference configuration/);
  assert.equal(run.status(), "Generation Approved");
  assert.equal(run.counts("generation-call"), 0);
  assert.equal((await run.recovery()).filter(entry => entry.operation === "generation").length, 0);
});

test("ambiguous submission is held for reconciliation and neither queued nor direct retry clicks again", async t => {
  const run = await simulator(t, { attended: true });
  await run.prepareSubmission();
  run.controls.confirmation = false;
  await assert.rejects(run.load("upload.js")(), /outcome is uncertain/);
  assert.equal(run.status(), "Submission Uncertain");
  assert.match(run.row().notes, /^Submission attempt /);
  assert.ok((await run.recovery()).some(entry => entry.finding === "submission-outcome-unknown" &&
    run.row().notes.includes(entry.attemptId)));
  assert.equal(run.row().uploadedAt, undefined);
  await assert.rejects(run.load("upload.js")(), /consumed/);
  await assert.rejects(run.submit(), /consumed/);
  assert.equal(run.counts("mock-submit"), 1);
  assert.equal(run.counts("mock-submit-browser"), 1);
});

test("a clarification arriving after attachment blocks the final submit click", async t => {
  const run = await simulator(t);
  await run.prepareSubmission();
  run.controls.afterAttachment = () => run.receive("between-attach-and-submit");
  await assert.rejects(run.submit(), /fresh project review/);
  assert.equal(run.status(), "Submission Approved");
  assert.equal(run.counts("mock-attach"), 1);
  assert.equal(run.counts("mock-submit"), 0);
});

test("a failed final audit write preserves the uncertain claim and blocks a second attempt", async t => {
  const run = await simulator(t, { attended: true });
  await run.prepareSubmission();
  run.controls.onSheetUpdate = values => {
    if (values.Status === "Uploaded") throw new Error("mock final audit write failed");
  };
  await assert.rejects(run.submit(), /final audit write failed/);
  assert.equal(run.status(), "Submission Uncertain");
  assert.equal(run.row().uploadedAt, undefined);
  assert.ok((await run.recovery()).some(entry => entry.finding === "confirmed-audit-pending"));
  await assert.rejects(run.submit(), /consumed/);
  assert.equal(run.counts("mock-submit"), 1);
});

test("a competing workflow attempt cannot enter while the synthetic generation worker is in flight", async t => {
  const run = await simulator(t, { attended: true });
  await run.prepareGeneration();
  let enter;
  let release;
  const entered = new Promise(resolve => { enter = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  run.controls.onGeneration = async () => { enter(); await barrier; };
  const first = run.generate();
  try {
    await Promise.race([entered, first]);
    await assert.rejects(run.generate(), /lock is held/);
    await assert.rejects(run.submit(), /lock is held/);
    await assert.rejects(run.load("voice123.js").uploadAudio(run.row().url), /lock is held/);
    assert.equal(run.counts("storage-get"), 0);
  } finally {
    release();
    await first;
  }
  assert.equal(run.status(), "Pending Submission Approval");
  assert.equal(run.counts("generation-call"), 1);
  assert.equal(run.counts("mock-submit-browser"), 0);
});
