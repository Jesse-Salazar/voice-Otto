const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const { generateKeyPairSync, randomUUID, sign } = require("node:crypto");
const { fingerprint } = require("../approval-evidence");
const { initializeAuthority, createAuthority, readAuthorityLedger } = require("../authority-service");
const { authorityRequest, openAuthorityPermit } = require("../authority-client");

const baseline = { projectId: "SYNTH12AAUDITION", trackingId: "synthetic-audition",
  approvalSha256: "a".repeat(64), clarificationSha256: "b".repeat(64), audioSha256: null };

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/voa-"));
  const directory = path.join(root, "authority");
  const executor = path.join(root, "executor");
  const socketDirectory = path.join(root, "run");
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.mkdirSync(executor, { mode: 0o700 });
  fs.mkdirSync(socketDirectory, { mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const authorityId = randomUUID();
  const socketPath = path.join(socketDirectory, "authority.sock");
  const operatorPublicKey = publicKey.export({ type: "spki", format: "pem" });
  initializeAuthority(directory, authorityId);
  const { head: checkpoint } = readAuthorityLedger(directory, authorityId);
  const config = { authorityId, directory, operatorPublicKey, socketPath, checkpoint };
  const server = fork(path.join(__dirname, "fixtures", "authority-worker.cjs"), [JSON.stringify(config)]);
  let exited = false;
  const stopped = once(server, "exit").then(result => { exited = true; return result; });
  t.after(async () => {
    if (!exited) {
      server.kill("SIGKILL");
      await stopped;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  await Promise.race([once(server, "message"), stopped.then(() => { throw new Error("Authority failed to start"); })]);
  const request = input => authorityRequest(socketPath, input);
  function signed(action, payload, signingKey = privateKey) {
    const command = { authorityId, nonce: randomUUID(), action, payload, expiresAt: Date.now() + 30_000 };
    return { action: "operator", command,
      signature: sign(null, Buffer.from(fingerprint(command), "hex"), signingKey).toString("base64") };
  }
  const operator = (action, payload) => request(signed(action, payload));
  async function grant(operation, binding) {
    return operator("grant", { operation, binding, reference: "offline-operator-decision", expiresAt: Date.now() + 120_000 });
  }
  const issue = grantId => operator("issue", { grantId, expiresAt: Date.now() + 60_000 });
  const open = permit => openAuthorityPermit(permit.operation, { socketPath, permitId: permit.id });
  const ledger = checkpoint => readAuthorityLedger(directory, authorityId, { operatorPublicKey, checkpoint });
  const stop = async () => { server.send("stop"); await stopped; };
  return { executor, directory, config, ledger, request, signed, operator, grant, issue, open, stop };
}

for (const operation of ["discovery", "generation", "submission"]) {
  test(`authority independently records an exact single-use ${operation} claim`, async t => {
    const f = await fixture(t);
    const binding = { ...baseline, audioSha256: operation === "submission" ? "c".repeat(64) : null };
    const grant = await f.grant(operation, binding);
    const permit = await f.issue(grant);
    assert.deepEqual(Object.fromEntries(Object.keys(binding).map(key => [key, permit[key]])), binding);
    await assert.rejects(f.issue(grant), /previously issued grant/);
    const handle = await f.open(permit);
    await assert.rejects(handle.claim({ ...binding, trackingId: "synthetic-wrong" }, randomUUID()), /evidence changed/);
    if (operation === "submission") await assert.rejects(handle.claim({ ...binding, audioSha256: "d".repeat(64) }, randomUUID()), /evidence changed/);
    const attemptId = randomUUID();
    await handle.claim(binding, attemptId);
    await handle.validate(binding, attemptId);
    await assert.rejects(f.open(permit), /consumed/);
    const records = f.ledger().records;
    assert.deepEqual(records.map(record => record.event), ["grant", "issue", "claim"]);
    assert.deepEqual(records[2].data, { ...binding, operation, permitId: permit.id, attemptId, outcome: "unresolved" });
    await f.operator("reconcile", { permitId: permit.id, attemptId, outcome: "confirmed-complete", reference: "mock-receipt" });
    await assert.rejects(f.issue(await f.grant(operation, binding)), /already complete/);
  });
}

test("executor cannot issue, amend grants, erase the ledger or forge terminal confirmation through the socket", async t => {
  const f = await fixture(t);
  const grantId = await f.grant("generation", baseline);
  const before = f.ledger().head;
  for (const action of ["grant", "revoke", "issue", "truncate", "delete", "rewrite", "reconcile"]) {
    await assert.rejects(f.request({ action, grantId, confirmation: "ISSUE SYNTH12AAUDITION generation" }), /Unsupported executor request/);
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  const payload = { grantId, expiresAt: Date.now() + 60_000 };
  await assert.rejects(f.request(f.signed("issue", payload, privateKey)), /Invalid operator signature/);
  await assert.rejects(f.grant("generation", { ...baseline, projectId: "INVQUDO70" }), /synthetic/);
  assert.deepEqual(f.ledger().head, before);
  const signedRequest = f.signed("issue", payload);
  await f.request(signedRequest);
  await assert.rejects(f.request(signedRequest), /command replay/);
});

test("concurrent claims have one winner and a second authority cannot start against the same ledger", async t => {
  const f = await fixture(t);
  assert.throws(() => createAuthority(f.config), { code: "EEXIST" });
  const permit = await f.issue(await f.grant("generation", baseline));
  const handles = await Promise.all(Array.from({ length: 5 }, () => f.open(permit)));
  const results = await Promise.allSettled(handles.map(handle => handle.claim(baseline, randomUUID())));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(f.ledger().records.filter(record => record.event === "claim").length, 1);
});

test("changed approval and clarification fingerprints fail closed; revoking the grant blocks an opened handle", async t => {
  const f = await fixture(t);
  const grantId = await f.grant("generation", baseline);
  const handle = await f.open(await f.issue(grantId));
  for (const key of ["approvalSha256", "clarificationSha256"]) {
    await assert.rejects(handle.claim({ ...baseline, [key]: "9".repeat(64) }, randomUUID()), /evidence changed/);
  }
  await f.operator("revoke", { grantId });
  await assert.rejects(handle.claim(baseline, randomUUID()), /revoked/);
  assert.equal(f.ledger().records.some(record => record.event === "claim"), false);
});

test("unavailable authority and interrupted authoritative commits block the mocked action", async t => {
  const f = await fixture(t);
  const handle = await f.open(await f.issue(await f.grant("generation", baseline)));
  fs.writeFileSync(path.join(f.directory, "head.pending"), "simulated interrupted commit", { mode: 0o600 });
  await assert.rejects(handle.claim(baseline, randomUUID()), /commit uncertain/);
  await assert.rejects(handle.claim(baseline, randomUUID()), /Authority unavailable/);
  await f.stop();
  assert.throws(() => createAuthority(f.config), /Interrupted authority commit/);
  await assert.rejects(handle.claim(baseline, randomUUID()), /Authority unavailable or response lost/);
});

test("executor rollback, lost local recovery, crash during action and ambiguous submission leave the authority claim unresolved", async t => {
  const f = await fixture(t);
  const binding = { ...baseline, audioSha256: "c".repeat(64) };
  const permit = await f.issue(await f.grant("submission", binding));
  const local = path.join(f.executor, "recovery");
  fs.writeFileSync(local, "workspace snapshot before action");
  const worker = fork(path.join(__dirname, "fixtures", "authority-client-crash.cjs"),
    [f.config.socketPath, JSON.stringify(permit), JSON.stringify(binding), local]);
  assert.deepEqual(await once(worker, "exit"), [null, "SIGKILL"]);
  assert.equal(fs.readFileSync(local, "utf8"), "mock submission started; no outcome");
  fs.writeFileSync(local, "workspace snapshot before action");
  await assert.rejects(f.open(permit), /consumed/);
  fs.unlinkSync(local);
  const claim = f.ledger().records.at(-1).data;
  assert.equal(claim.outcome, "unresolved");
  assert.equal(claim.permitId, permit.id);
  const replacement = await f.grant("submission", binding);
  await assert.rejects(f.issue(replacement), /requires reconciliation/);
  await assert.rejects(f.operator("reconcile", { permitId: permit.id, attemptId: claim.attemptId, outcome: "uncertain",
    reference: "no-confirmation" }), /verified reconciliation/);
  await f.operator("reconcile", { permitId: permit.id, attemptId: claim.attemptId, outcome: "confirmed-no-action",
    reference: "independent-mock-provider-check" });
  assert.notEqual((await f.issue(replacement)).id, permit.id);
});

test("the auditor detects journal corruption and authority rollback against an independently retained checkpoint", async t => {
  const f = await fixture(t);
  const journal = path.join(f.directory, "journal.jsonl");
  const head = path.join(f.directory, "head.json");
  const snapshot = [fs.readFileSync(journal), fs.readFileSync(head)];
  const permit = await f.issue(await f.grant("discovery", baseline));
  await (await f.open(permit)).claim(baseline, randomUUID());
  const { head: checkpoint } = f.ledger();
  await f.stop();
  const restarted = createAuthority({ ...f.config, checkpoint });
  try {
    assert.throws(() => restarted.dispatch({ action: "open", permitId: permit.id }), /consumed/);
  } finally { restarted.close(); }
  const current = fs.readFileSync(journal, "utf8");
  fs.writeFileSync(journal, current.replace("unresolved", "forged"));
  assert.throws(() => f.ledger(), /integrity failure/);
  assert.throws(() => createAuthority({ ...f.config, checkpoint }), /integrity failure/);
  fs.writeFileSync(journal, snapshot[0]);
  fs.writeFileSync(head, snapshot[1]);
  assert.throws(() => createAuthority({ ...f.config, checkpoint }), /Independent checkpoint mismatch/);
});

test("startup fails closed without an independent checkpoint and preserves the ledger", async t => {
  const f = await fixture(t);
  await f.issue(await f.grant("discovery", baseline));
  const before = f.ledger();
  await f.stop();
  for (const checkpoint of [undefined, null, {}]) {
    assert.throws(() => createAuthority({ ...f.config, checkpoint }), /Independent checkpoint (required|mismatch)/);
  }
  assert.deepEqual(f.ledger(), before);
});

test("OS socket traversal denial blocks claims without a local fallback", {
  skip: process.getuid() === 0 && "Root can bypass directory traversal permissions"
}, async t => {
  const f = await fixture(t);
  const permit = await f.issue(await f.grant("generation", baseline));
  const handle = await f.open(permit);
  const socketParent = path.dirname(f.config.socketPath);
  const before = f.ledger();
  fs.chmodSync(socketParent, 0o000);
  try {
    const probe = net.createConnection(f.config.socketPath);
    try { await assert.rejects(once(probe, "connect"), { code: "EACCES" }); }
    finally { probe.destroy(); }
    await assert.rejects(handle.claim(baseline, randomUUID()), /Authority unavailable/);
  } finally {
    fs.chmodSync(socketParent, 0o700);
  }
  assert.deepEqual(f.ledger(), before);
  await (await f.open(permit)).validate(baseline);
});
