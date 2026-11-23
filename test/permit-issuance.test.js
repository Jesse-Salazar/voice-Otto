const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { PassThrough, Writable } = require("node:stream");
const { runIssuance } = require("../issue-permit");
const { issuePermit, openPermit, revokePermit, reconcilePermit } = require("../execution-permit");
const { appendClarification, currentProjectMaterial } = require("../clarification-log");
const { sha256, rights, transition } = require("../approval-evidence");

const project = "SYNTH11BVOICE";
const tracking = "synthetic-11b-tracking";
const authorization = "fixture-decision";
const url = `https://voice123.com/projects/${project}/fixture/specs`;
const inputs = { voice: "dummy-voice", model: "dummy-model", settings: { stability: 0.6 } };
const script = "A synthetic recording line.";
const bytes = Buffer.from("offline dummy audio bytes");
const expiry = () => new Date(Date.now() + 3_600_000).toISOString();

async function fixture(t, operation = "generation") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-otto-issuance-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sources = path.join(root, "sources", project);
  const journal = path.join(root, "clarifications.jsonl");
  await fs.mkdir(sources, { recursive: true });
  await fs.writeFile(path.join(sources, "terms.txt"), "Synthetic terms");
  await fs.writeFile(path.join(root, "dummy.mp3"), bytes, { mode: 0o600 });
  const append = event => appendClarification(journal, {
    source: "offline fixture", observedProjectId: project, timestamp: new Date().toISOString(), ...event
  }, [{ id: project, title: "Synthetic fixture" }]);
  await append({ kind: "project-material", reviewer: "reviewer-one", verifiedSource: "fixture",
    reviewedThrough: null, script: { version: "1", sha256: sha256(script) },
    terms: { filename: "terms.txt", version: "1", sha256: sha256("Synthetic terms") },
    agreement: null, agreementRequired: false, attachments: [] });
  let row = { id: tracking, url, status: "Needs Review" };
  const approve = (stage, reviewer, data) => {
    const change = transition(row, stage, { reviewer, expiresAt: expiry(), ...data });
    row = { ...row, status: change.Status, evidence: change["Approval Evidence"], script };
  };
  approve("project", "reviewer-one", { script, clarification: await currentProjectMaterial(journal, project),
    attachmentReview: { outcome: "none", reason: "Fixture contains no attachment" },
    revisionReview: { outcome: "new invitation", reason: "Fixture is new" },
    rights: Object.fromEntries(rights.map(right => [right, { outcome: "cleared", reason: "Fixture rights reviewed" }])) });
  if (operation === "discovery") {
    row = { ...row, status: "Pending Discovery", discoveryPlan: { voice123Id: project, url, status: "Needs Review", script: null } };
  } else {
    approve("generation", "reviewer-two", { inputs });
    row.generationInputs = inputs;
  }
  if (operation === "submission") {
    row = { ...row, status: "Pending Submission Approval", audioUrl: "https://example.invalid/synthetic-audio",
      voiceSettings: JSON.stringify(inputs.settings), stagedAudio: "dummy.mp3" };
    approve("submission", "reviewer-three", { audioSha256: sha256(bytes), inputs });
  }
  const write = (file, data) => fs.writeFile(path.join(root, file), JSON.stringify(data), { mode: 0o600 });
  const account = os.userInfo();
  const grant = { reference: authorization, operator: account.username, uid: account.uid, projectId: project, trackingId: tracking,
    operation, status: "active", createdAt: new Date().toISOString(), expiresAt: expiry() };
  await write("authorizations.json", [grant]);
  await write("projects.json", [row]);
  const args = ["--workspace", root, "--project", project, "--tracking", tracking, "--operation", operation,
    "--authorization", authorization, ...(operation === "submission" ? ["--audio-sha256", sha256(bytes)] : [])];
  return { operation, root, args, row, grant, write, append, directory: path.join(await fs.realpath(root), "permits") };
}

function interactive(f, { answer = `ISSUE ${project} ${f.operation}`, onPrompt, args = f.args, eof = false } = {}) {
  const input = new PassThrough();
  let transcript = "";
  let prompted = false;
  const output = new Writable({ write(chunk, encoding, next) {
    transcript += chunk.toString();
    if (!prompted && transcript.includes("to issue the synthetic permit:")) {
      prompted = true;
      setImmediate(async () => {
        try {
          await onPrompt?.();
          if (eof) input.end();
          else input.write(answer + "\n");
        } catch (error) { input.destroy(error); }
      });
    }
    next();
  } });
  input.isTTY = output.isTTY = true;
  const result = runIssuance(args, { input, output });
  return { result, transcript: () => transcript };
}

for (const scope of ["discovery", "generation", "submission"]) {
  test(`interactive ${scope} issuance shows the scoped summary and writes an audited isolated permit`, async t => {
    const f = await fixture(t, scope);
    const run = interactive(f, { args: [...f.args, "--minutes", "60"] });
    const permit = await run.result;
    assert.equal(permit.projectId, project);
    assert.equal(permit.trackingId, tracking);
    assert.equal(permit.operation, scope);
    assert.ok(Date.parse(permit.expiresAt) - Date.parse(permit.createdAt) <= 3_600_000);
    for (const field of ["scriptSha256", "approvalSha256", "clarificationSha256", "expectedEffectsIfExecuted", f.row.status]) {
      assert.ok(run.transcript().includes(field));
    }
    if (scope === "submission") {
      assert.ok(run.transcript().includes(sha256(bytes)) && run.transcript().includes("Voice123 project " + project));
    }
    assert.ok(!run.transcript().includes(script));
    const audit = JSON.parse(await fs.readFile(path.join(f.directory, permit.id + ".issued")));
    assert.equal(audit.permitId, permit.id);
    assert.equal(audit.confirmation, `ISSUE ${project} ${scope}`);
    await openPermit(scope, { permitId: permit.id, directory: f.directory });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root, "projects.json"))), [f.row]);
  });
}

test("unattended, missing, or incorrect confirmation cannot issue", async t => {
  const f = await fixture(t);
  assert.throws(() => execFileSync(process.execPath, [path.join(__dirname, "../issue-permit.js"), ...f.args], {
    input: `ISSUE ${project} generation\n`, stdio: "pipe"
  }), /Interactive terminal/);
  await assert.rejects(interactive(f, { eof: true }).result, /confirmation/);
  await assert.rejects(interactive(f, { answer: `ISSUE ${project} submission` }).result, /confirmation/);
  await assert.rejects(fs.stat(f.directory), { code: "ENOENT" });
});

test("wrong, duplicated, or real project identity and invalid operator references are blocked", async t => {
  const f = await fixture(t);
  const replace = (name, value) => f.args.map((argument, index) => f.args[index - 1] === name ? value : argument);
  for (const [option, value, reason] of [["--project", "INVQUDO70", /synthetic/], ["--project", "SYNTH11BOTHER", /authorization/],
    ["--tracking", "synthetic-wrong", /authorization/], ["--authorization", "wrong", /authorization/]]) {
    await assert.rejects(interactive(f, { args: replace(option, value) }).result, reason);
  }
  await assert.rejects(interactive(f, { args: [...f.args, "--operation", "discovery"] }).result, /Exactly one/);
  await assert.rejects(interactive(f, { args: [...f.args, "--project", project] }).result, /ambiguous/);
  await f.write("authorizations.json", [{ ...f.grant, uid: f.grant.uid + 1 }]);
  await assert.rejects(interactive(f).result, /authorization/);
  await f.write("authorizations.json", [f.grant]);
  await f.write("projects.json", [f.row, { ...f.row, id: "synthetic-other" }]);
  await assert.rejects(interactive(f).result, /identity/);
  await assert.rejects(issuePermit({ projectId: "INVQUDO70" }), /Production permit issuance is disabled/);
  await assert.rejects(issuePermit({ projectId: "INVQTR98G" }, { directory: f.directory }), /Only synthetic/);
});

test("rights, missing or malformed evidence, expired evidence and revoked approval fail closed", async t => {
  const f = await fixture(t);
  for (const evidence of ["", "{", ...["rights", "expired", "revoked"].map(change => {
    const data = JSON.parse(f.row.evidence);
    if (change === "rights") delete data.project.rights[rights[0]];
    else if (change === "expired") data.generation.expiresAt = "2000-01-01T00:00:00.000Z";
    else data.generation.decision = "revoked";
    return JSON.stringify(data);
  })]) {
    await f.write("projects.json", [{ ...f.row, evidence }]);
    await assert.rejects(interactive(f).result, /evidence|approval/i);
  }
  await assert.rejects(fs.stat(f.directory), { code: "ENOENT" });
});

test("current clarification and operator authorization are rechecked after confirmation", async t => {
  const f = await fixture(t);
  await assert.rejects(interactive(f, { onPrompt: () => f.write("authorizations.json", [{ ...f.grant, status: "revoked" }]) }).result,
    /authorization/);
  await f.write("authorizations.json", [f.grant]);
  await assert.rejects(interactive(f, { onPrompt: () => f.append({
    kind: "message", messageId: "new-message", direction: "inbound", text: "New synthetic terms",
    sender: { id: "fixture-client", verification: "verified" }, recipient: { id: "fixture-user", verification: "verified" }
  }) }).result, /Clarification evidence/);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test("submission rejects incorrect SHA-256 and changed staged bytes after confirmation", async t => {
  const f = await fixture(t, "submission");
  const args = f.args.map(value => value === sha256(bytes) ? "a".repeat(64) : value);
  await assert.rejects(interactive(f, { args }).result, /Approved audio bytes/);
  await assert.rejects(interactive(f, { onPrompt: () => fs.writeFile(path.join(f.root, "dummy.mp3"), "changed bytes") }).result,
    /Staged audio SHA-256/);
});

test("duplicate, expiry, revocation, consumption and manual replacement preserve audit history", async t => {
  const f = await fixture(t);
  const original = await interactive(f).result;
  const open = (id, clock) => openPermit(f.operation, { permitId: id, directory: f.directory, clock });
  await assert.rejects(interactive(f).result, /unconsumed/);
  await assert.rejects(open(original.id, () => Date.parse(original.expiresAt)), /expired/);
  const human = { operator: "synthetic-reconciler", authorization: "fixture-reconciliation" };
  await revokePermit(original.id, human, f.directory);
  await assert.rejects(open(original.id), /revoked/);
  const next = await interactive(f).result;
  const handle = await open(next.id);
  await handle.claim(next, randomUUID());
  await assert.rejects(interactive(f).result, /manual reconciliation/);
  await assert.rejects(reconcilePermit(next.id, { ...human, outcome: "uncertain" }, f.directory), /verified human/);
  await reconcilePermit(next.id, { ...human, outcome: "confirmed-no-action" }, f.directory);
  const replacement = await interactive(f).result;
  assert.equal((await fs.readdir(f.directory)).filter(file => file.endsWith(".issued")).length, 3);
  await open(replacement.id);
});

test("corrupted or missing audit blocks open and replacement", async t => {
  const f = await fixture(t);
  const permit = await interactive(f).result;
  const audit = path.join(f.directory, permit.id + ".issued");
  const data = JSON.parse(await fs.readFile(audit));
  await fs.writeFile(audit, JSON.stringify({ ...data, operator: "tampered" }));
  await assert.rejects(openPermit(f.operation, { permitId: permit.id, directory: f.directory }), /audit/);
  await assert.rejects(interactive(f).result, /audit/);
  await fs.unlink(audit);
  await assert.rejects(openPermit(f.operation, { permitId: permit.id, directory: f.directory }), { code: "ENOENT" });
});

test("the real CLI accepts a pseudo-terminal with a valid grant but exposes no grant-writing command", async t => {
  const f = await fixture(t);
  const cli = path.join(__dirname, "../issue-permit.js");
  const registry = path.join(f.root, "authorizations.json");
  const original = await fs.readFile(registry);
  const automate = (args, confirmation) => execFileSync("python3", ["-c", `
import errno, os, pty, select, subprocess, sys, time
master, slave = pty.openpty()
proc = subprocess.Popen(sys.argv[2:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
transcript = b""
sent = False
try:
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.1)
        if not ready:
            if proc.poll() is not None:
                break
            continue
        try:
            data = os.read(master, 4096)
        except OSError as err:
            if err.errno == errno.EIO:
                break
            raise
        if not data:
            break
        transcript += data
        if not sent and b"to issue the synthetic permit:" in transcript:
            os.write(master, (sys.argv[1] + "\\n").encode())
            sent = True
    proc.wait(timeout=2)
    sys.stdout.buffer.write(transcript)
    sys.exit(proc.returncode)
finally:
    if proc.poll() is None:
        proc.kill()
        proc.wait()
    os.close(master)
`, confirmation, process.execPath, cli, ...args], { encoding: "utf8", timeout: 12_000 });
  const result = automate(f.args, `ISSUE ${project} generation`);
  assert.match(result, /Issued synthetic permit [a-f0-9-]{36}/);
  assert.throws(() => automate([...f.args, "--create-authorization"], ""), /Command failed/);
  assert.deepEqual(await fs.readFile(registry), original);
});

test("a grant must exist and remain active, unexpired and scoped to the requested operation", async t => {
  const f = await fixture(t);
  for (const grants of [[], [{ ...f.grant, expiresAt: new Date(0).toISOString() }],
    [{ ...f.grant, status: "revoked" }], [{ ...f.grant, operation: "submission" }]]) {
    await f.write("authorizations.json", grants);
    await assert.rejects(interactive(f).result, /authorization/);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root, "authorizations.json"))), grants);
  }
  await assert.rejects(fs.stat(f.directory), { code: "ENOENT" });
});

test("raw helper cannot inject a forged audit or no-op revalidation for an interactive scope", async t => {
  const f = await fixture(t);
  await assert.rejects(issuePermit({ projectId: project }, { directory: f.directory,
    audit: { summary: {} }, revalidate: async () => {} }), /isolated audited permit store/);
  await assert.rejects(fs.stat(f.directory), { code: "ENOENT" });
});

test("SIGKILL before claim leaves the permit usable; after claim and during mock action require reconciliation", async t => {
  for (const phase of ["before", "after", "during"]) {
    const f = await fixture(t);
    const permit = await interactive(f).result;
    const action = path.join(f.root, "mock-action-started");
    assert.throws(() => execFileSync(process.execPath, ["-e", `
      const {openPermit}=require(process.argv[1]);
      const [directory,raw,phase,action]=process.argv.slice(2);
      (async()=>{
        const permit=JSON.parse(raw);
        const handle=await openPermit(permit.operation,{directory,permitId:permit.id});
        if(phase!=='before') await handle.claim(permit,require('node:crypto').randomUUID());
        if(phase==='during') require('node:fs').writeFileSync(action,'started without outcome',{flag:'wx'});
        process.kill(process.pid,'SIGKILL');
      })().catch(()=>process.exit(2));
    `, path.join(__dirname, "../execution-permit.js"), f.directory, JSON.stringify(permit), phase, action]), { signal: "SIGKILL" });
    const open = () => openPermit(permit.operation, { directory: f.directory, permitId: permit.id });
    if (phase === "before") {
      await open();
      await assert.rejects(interactive(f).result, /unconsumed/);
    } else {
      await assert.rejects(open(), /consumed/);
      await assert.rejects(interactive(f).result, /manual reconciliation/);
      if (phase === "during") assert.equal(await fs.readFile(action, "utf8"), "started without outcome");
      else await assert.rejects(fs.stat(action), { code: "ENOENT" });
    }
  }
});

test("losing the claim or the entire permit store does not silently reopen issuance", async t => {
  const f = await fixture(t);
  const permit = await interactive(f).result;
  const open = () => openPermit(permit.operation, { directory: f.directory, permitId: permit.id });
  await (await open()).claim(permit, randomUUID());
  await fs.unlink(path.join(f.directory, permit.id + ".claim"));
  await assert.rejects(open(), /Inconsistent permit consumption/);
  await assert.rejects(interactive(f).result, /manual reconciliation/);
  await fs.rename(f.directory, path.join(f.root, "preserved-permits"));
  await assert.rejects(open(), { code: "ENOENT" });
  await assert.rejects(interactive(f).result, { code: "ENOENT" });
  await assert.rejects(fs.stat(f.directory), { code: "ENOENT" });
});
