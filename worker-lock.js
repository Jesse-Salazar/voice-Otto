const net = require("node:net");

// Use the same endpoint across checkouts and both sensitive entry points.
// The OS releases the bind when the process exits, even after SIGKILL.
const endpoint = { host: "127.0.0.1", port: 48672, exclusive: true };

class WorkerLockError extends Error {
  constructor(cause) {
    super(cause.code === "EADDRINUSE"
      ? "A generation or submission worker is already active on this machine"
      : "Could not acquire the local generation and submission lock", { cause });
    this.name = "WorkerLockError";
  }
}

async function withWorkerLock(work) {
  const server = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", error => reject(new WorkerLockError(error)));
    server.listen(endpoint, resolve);
  });
  try {
    return await work();
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

module.exports = { withWorkerLock };
