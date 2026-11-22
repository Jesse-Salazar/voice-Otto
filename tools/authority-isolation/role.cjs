const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, generateKeyPairSync, sign } = require("node:crypto");
const { authorityRequest, openAuthorityPermit } = require("./authority-client");
const { createAuthority, authorityListener, initializeAuthority, readAuthorityLedger } = require("./authority-service");
const { fingerprint } = require("./approval-evidence");

async function main() {
  const [action, root, raw] = process.argv.slice(2);
  const input = raw && JSON.parse(raw);
  const filename = path.join(root, "operator", "signer.pem");
  const state = path.join(root, "state");
  const socket = path.join(root, "run", "gateway.sock");
  const request = message => authorityRequest(socket, message);
  switch (action) {
    case "keys": {
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      fs.writeFileSync(filename, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
      return publicKey.export({ type: "spki", format: "pem" });
    }
    case "initialize":
      initializeAuthority(state, input);
      return readAuthorityLedger(state, input).head;
    case "serve": {
      const operatorPublicKey = fs.readFileSync(path.join(state, "verify.pem"), "utf8");
      const checkpoint = JSON.parse(fs.readFileSync(path.join(root, "checkpoint", "head.json"), "utf8"));
      const authority = createAuthority({ directory: state, authorityId: input, operatorPublicKey, checkpoint });
      const listener = authorityListener(authority);
      listener.listen(path.join(state, "private.sock"));
      process.on("SIGTERM", () => listener.close(() => authority.close()));
      return;
    }
    case "operator":
    case "sign-only": {
      const command = { authorityId: input.authorityId, nonce: randomUUID(),
        action: input.action, payload: input.payload,
        expiresAt: Date.now() + (action === "sign-only" ? 60_000 : 15_000) };
      const signedRequest = {
        action: "operator",
        command,
        signature: sign(null, Buffer.from(fingerprint(command), "hex"),
          fs.readFileSync(filename)).toString("base64")
      };
      return action === "sign-only" ? signedRequest : request(signedRequest);
    }
    case "raw": return request(input);
    case "open": return (await openAuthorityPermit(input.operation, { socketPath: socket, permitId: input.id })).permit;
    case "claim":
    case "crash": {
      const permit = input.permit;
      const handle = await openAuthorityPermit(permit.operation, { socketPath: socket, permitId: permit.id });
      const attemptId = randomUUID();
      await handle.claim(input.binding, attemptId);
      if (action === "crash") process.kill(process.pid, "SIGKILL");
      return attemptId;
    }
    case "probe-files":
      return Object.entries(input).map(([probe, target]) => {
        try {
          if (probe.startsWith("read")) fs.closeSync(fs.openSync(target, "r"));
          else if (probe.startsWith("write")) fs.closeSync(fs.openSync(target, "r+"));
          else if (probe.startsWith("create")) fs.closeSync(fs.openSync(target, "wx"));
          else fs.unlinkSync(target);
          return [probe, "ALLOWED"];
        } catch (error) { return [probe, error.code]; }
      });
    default: throw new Error("Unknown fixture operation");
  }
}

main().then(value => {
  if (value !== undefined) console.log(JSON.stringify({ uid: process.getuid(), value }));
}, error => {
  console.error(error.code || error.message);
  process.exitCode = 1;
});
