const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { openAuthorityPermit } = require("../../authority-client");

async function main() {
  const [socketPath, rawPermit, rawBinding, local] = process.argv.slice(2);
  const permit = JSON.parse(rawPermit);
  const binding = JSON.parse(rawBinding);
  const attemptId = randomUUID();
  const handle = await openAuthorityPermit(permit.operation, { socketPath, permitId: permit.id });
  await handle.claim(binding, attemptId);
  await handle.validate(binding, attemptId);
  fs.writeFileSync(local, "mock submission started; no outcome");
  process.kill(process.pid, "SIGKILL");
}

main().catch(() => { process.exitCode = 1; });
