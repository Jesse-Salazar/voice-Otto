// Offline authority prototype. Run the listener and store under the authority identity.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { createPublicKey, randomUUID, verify } = require("node:crypto");
const { fingerprint } = require("./approval-evidence");

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const operations = ["discovery", "generation", "submission"];
const outcomes = ["confirmed-complete", "confirmed-no-action", "confirmed-failed"];
const reference = /^[a-zA-Z0-9_.:-]{1,100}$/;
const token = (pattern, input) => typeof input === "string" && pattern.test(input);
const requireValid = (condition, reason) => { if (!condition) throw new Error(reason); };
const fields = (obj, ...keys) => obj && Object.keys(obj).length === keys.length && keys.every(key => Object.hasOwn(obj, key));

function validateBinding(binding, operation) {
  requireValid(operations.includes(operation) &&
    fields(binding, "projectId", "trackingId", "approvalSha256", "clarificationSha256", "audioSha256") &&
    token(/^SYNTH12A[A-Z0-9]{1,60}$/, binding.projectId) &&
    token(/^synthetic-[a-zA-Z0-9_-]{1,80}$/, binding.trackingId) &&
    token(hash, binding.approvalSha256) && token(hash, binding.clarificationSha256) &&
    (operation === "submission" ? token(hash, binding.audioSha256) : binding.audioSha256 === null),
  "Invalid synthetic authorization binding");
}

function openPrivate(filename, flags) {
  const fd = fs.openSync(filename, flags | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    requireValid(stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1 && !(stat.mode & 0o077),
      "Unsafe authority file");
    return fd;
  } catch (error) { fs.closeSync(fd); throw error; }
}

function readPrivate(filename) {
  const fd = openPrivate(filename, fs.constants.O_RDONLY);
  try {
    requireValid(fs.fstatSync(fd).size <= 4 * 1024 * 1024, "Authority journal exceeds prototype limit");
    return fs.readFileSync(fd, "utf8");
  } finally { fs.closeSync(fd); }
}

function writePrivate(filename, data, flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY) {
  const fd = openPrivate(filename, flags);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function validateDirectory(directory) {
  const stat = fs.lstatSync(directory);
  requireValid(stat.isDirectory() && stat.uid === process.getuid() && !(stat.mode & 0o077) &&
    fs.realpathSync(directory) === directory, "Authority store must be a private, authority-owned directory");
}

function initializeAuthority(directory, authorityId) {
  requireValid(token(uuid, authorityId), "Invalid authority identity");
  validateDirectory(directory);
  // Provision explicitly. Startup never recreates a lost store.
  writePrivate(path.join(directory, "journal.jsonl"), "");
  writePrivate(path.join(directory, "head.json"), JSON.stringify({ authorityId, sequence: 0, hash: null }));
  syncDirectory(directory);
}

function signedBy(command, signature, key) {
  return token(/^[A-Za-z0-9+/]{86}==$/, signature) &&
    verify(null, Buffer.from(fingerprint(command), "hex"), key, Buffer.from(signature, "base64"));
}

function readAuthorityLedger(directory, authorityId, { operatorPublicKey, checkpoint } = {}) {
  validateDirectory(directory);
  const head = JSON.parse(readPrivate(path.join(directory, "head.json")));
  const text = readPrivate(path.join(directory, "journal.jsonl"));
  requireValid(text === "" || text.endsWith("\n"), "Incomplete authority journal; reconcile manually");
  const records = text === "" ? [] : text.slice(0, -1).split("\n").map(line => JSON.parse(line));
  let previous = null;
  const key = operatorPublicKey && createPublicKey(operatorPublicKey);
  for (const [index, record] of records.entries()) {
    const { hash: digest, ...body } = record;
    requireValid(body.authorityId === authorityId && body.sequence === index + 1 &&
      body.previous === previous && digest === fingerprint(body), "Authority journal integrity failure");
    if (key && body.event !== "claim") {
      const { command, signature } = body.data.signed || {};
      requireValid(command?.authorityId === authorityId && command.action === body.event &&
        command.nonce === body.data.nonce && signedBy(command, signature, key) &&
        Object.entries(command.payload).every(([name, value]) => fingerprint(body.data[name]) === fingerprint(value)),
      "Authority event signature or signed payload mismatch");
    }
    previous = digest;
  }
  requireValid(head.authorityId === authorityId && head.sequence === records.length && head.hash === previous,
    "Authority checkpoint mismatch; reconcile manually");
  if (checkpoint) {
    requireValid(checkpoint.authorityId === authorityId && Number.isSafeInteger(checkpoint.sequence) &&
      checkpoint.sequence >= 0 && checkpoint.sequence <= records.length &&
      checkpoint.hash === (checkpoint.sequence ? records[checkpoint.sequence - 1].hash : null),
    "Independent checkpoint mismatch; reconcile manually");
  }
  return { head, records };
}

function createAuthority({ directory, authorityId, operatorPublicKey, checkpoint, clock = Date.now }) {
  validateDirectory(directory);
  requireValid(token(uuid, authorityId), "Invalid authority identity");
  requireValid(checkpoint && typeof checkpoint === "object",
    "Independent checkpoint required; reconcile manually before starting");
  const key = createPublicKey(operatorPublicKey);
  requireValid(key.asymmetricKeyType === "ed25519", "An Ed25519 operator key is required");
  const lock = path.join(directory, "service.lock");
  writePrivate(lock, String(process.pid));
  let available = true;
  let state;
  try {
    requireValid(!fs.existsSync(path.join(directory, "head.pending")), "Interrupted authority commit; reconcile manually");
    state = readAuthorityLedger(directory, authorityId, { operatorPublicKey, checkpoint });
  } catch (error) {
    fs.unlinkSync(lock);
    throw error;
  }

  function append(event, data) {
    const body = { authorityId, sequence: state.head.sequence + 1, previous: state.head.hash,
      at: clock(), event, data };
    const record = { ...body, hash: fingerprint(body) };
    const next = { authorityId, sequence: body.sequence, hash: record.hash };
    try {
      writePrivate(path.join(directory, "head.pending"), JSON.stringify(next));
      syncDirectory(directory);
      writePrivate(path.join(directory, "journal.jsonl"), JSON.stringify(record) + "\n",
        fs.constants.O_WRONLY | fs.constants.O_APPEND);
      fs.renameSync(path.join(directory, "head.pending"), path.join(directory, "head.json"));
      syncDirectory(directory);
    } catch {
      available = false;
      throw new Error("Authority commit uncertain; reconcile manually");
    }
    state.records.push(record);
    state.head = next;
    return record;
  }

  const find = (event, key, value) => state.records.find(record => record.event === event && record.data[key] === value)?.data;
  function grantActive(grantId) {
    const grant = find("grant", "grantId", grantId);
    requireValid(grant && !find("revoke", "grantId", grantId) && clock() < grant.expiresAt,
      "Operator grant is missing, expired or revoked");
    return grant;
  }

  function operator(request) {
    const { command, signature } = request;
    requireValid(fields(request, "action", "command", "signature") &&
      fields(command, "authorityId", "nonce", "action", "payload", "expiresAt") &&
      command.authorityId === authorityId && token(uuid, command.nonce) &&
      Number.isSafeInteger(command.expiresAt) && clock() < command.expiresAt &&
      command.expiresAt - clock() <= 300_000 &&
      signedBy(command, signature, key), "Invalid operator signature");
    requireValid(!state.records.some(record => record.data.nonce === command.nonce), "Operator command replay blocked");
    const { payload, nonce } = command;
    switch (command.action) {
      case "grant":
        requireValid(fields(payload, "binding", "operation", "reference", "expiresAt") && token(reference, payload.reference) &&
          Number.isSafeInteger(payload.expiresAt) && payload.expiresAt > clock() && payload.expiresAt - clock() <= 3600_000,
        "Invalid operator grant");
        validateBinding(payload.binding, payload.operation);
        return append("grant", { ...payload, grantId: randomUUID(), nonce, signed: request }).data.grantId;
      case "revoke":
        requireValid(fields(payload, "grantId") && find("grant", "grantId", payload.grantId) &&
          !find("revoke", "grantId", payload.grantId), "Unknown or already revoked grant");
        append("revoke", { ...payload, nonce, signed: request });
        return true;
      case "issue": {
        requireValid(fields(payload, "grantId", "expiresAt"), "Invalid issuance request");
        const grant = grantActive(payload.grantId);
        requireValid(Number.isSafeInteger(payload.expiresAt) && clock() < payload.expiresAt &&
          payload.expiresAt <= grant.expiresAt && !find("issue", "grantId", payload.grantId), "Invalid expiry or previously issued grant");
        for (const record of state.records.filter(record => record.event === "issue")) {
          const prior = record.data;
          if (prior.operation !== grant.operation || prior.projectId !== grant.binding.projectId) continue;
          const claim = find("claim", "permitId", prior.id);
          if (claim) {
            const resolution = find("reconcile", "permitId", prior.id);
            requireValid(resolution && resolution.outcome !== "confirmed-complete",
              "Prior outcome requires reconciliation or is already complete");
          } else {
            requireValid(prior.expiresAt <= clock() || find("revoke", "grantId", prior.grantId),
              "A current unclaimed authorization already exists");
          }
        }
        const permit = { ...grant.binding, id: randomUUID(), operation: grant.operation,
          expiresAt: payload.expiresAt, grantId: payload.grantId };
        append("issue", { ...permit, nonce, signed: request });
        return permit;
      }
      case "reconcile": {
        const { permitId, attemptId, outcome, reference: evidence } = payload || {};
        requireValid(fields(payload, "permitId", "attemptId", "outcome", "reference") &&
          find("claim", "permitId", permitId)?.attemptId === attemptId &&
          token(uuid, attemptId) && outcomes.includes(outcome) && token(reference, evidence) &&
          !find("reconcile", "permitId", permitId), "A verified reconciliation for the exact attempt is required");
        append("reconcile", { ...payload, nonce, signed: request });
        return true;
      }
      default: throw new Error("Unsupported operator action");
    }
  }

  function dispatch(request) {
    requireValid(available, "Authority unavailable; reconcile manually");
    if (request?.action === "operator") return operator(request);
    const { action, operation, permitId, binding, attemptId } = request || {};
    requireValid(["open", "validate", "claim"].includes(action) && token(uuid, permitId), "Unsupported executor request");
    const record = find("issue", "id", permitId);
    requireValid(record && (!operation || record.operation === operation), "Unknown or mismatched authorization");
    grantActive(record.grantId);
    requireValid(clock() < record.expiresAt, "Authorization expired");
    const claim = find("claim", "permitId", permitId);
    requireValid(!find("reconcile", "permitId", permitId), "Attempt is closed");
    if (action !== "open") {
      validateBinding(binding, record.operation);
      requireValid(Object.keys(binding).every(key => binding[key] === record[key]), "Authorization evidence changed");
    }
    if (action === "claim") {
      requireValid(token(uuid, attemptId) && !claim && !find("claim", "attemptId", attemptId), "Authorization already consumed or invalid claim");
      append("claim", { permitId, attemptId, operation: record.operation, ...binding, outcome: "unresolved" });
      return true;
    }
    requireValid(attemptId ? action === "validate" && claim?.attemptId === attemptId : !claim, "Authorization consumed or claim does not match");
    if (action === "validate") return true;
    const { nonce, signed, ...permit } = record;
    return permit;
  }

  let closed = false;
  return {
    dispatch,
    close() {
      if (closed) return;
      closed = true;
      available = false;
      fs.unlinkSync(lock);
    }
  };
}

function authorityListener(authority) {
  return http.createServer({ requestTimeout: 4000 }, async (request, response) => {
    if (request.method !== "POST" || request.url !== "/authorize") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    try {
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 8192) { response.writeHead(413).end(); return; }
      }
      const result = authority.dispatch(JSON.parse(body));
      response.end(JSON.stringify({ result }));
    } catch (error) {
      response.writeHead(403).end(JSON.stringify({ error: error.message }));
    }
  });
}

module.exports = { initializeAuthority, createAuthority, readAuthorityLedger, authorityListener };
