const assert = require("node:assert/strict");
const { once } = require("node:events");
const { fork } = require("node:child_process");
const { test } = require("node:test");
const path = require("node:path");
const { worker } = require("./fixtures/locked-worker.cjs");
const { withWorkerLock } = require("../worker-lock");

test("separate processes cannot start duplicate or overlapping generation and submission", { timeout: 15000 }, async () => {
  for (const kind of ["generation", "submission"]) {
    const child = fork(path.join(__dirname, "fixtures/locked-worker.cjs"), [kind]);
    const stopped = once(child, "exit");
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const [event] = await Promise.race([once(child, "message"), stopped]);
      assert.equal(event, "entered");
      for (const contender of ["generation", "submission"]) {
        await assert.rejects(worker(contender, () => assert.fail("Contending worker entered the action")),
          { name: "WorkerLockError" });
      }
    } finally {
      clearTimeout(watchdog);
      child.kill(kind === "generation" ? "SIGKILL" : "SIGTERM");
      await stopped;
    }
    assert.equal(await withWorkerLock(() => "released"), "released");
  }
});

test("a thrown operation releases the lock and a second local call cannot enter during work", async () => {
  await assert.rejects(withWorkerLock(async () => {
    await assert.rejects(withWorkerLock(() => assert.fail("Contending call entered")), { name: "WorkerLockError" });
    throw new Error("synthetic operation failed");
  }), /synthetic operation failed/);
  assert.equal(await withWorkerLock(() => 42), 42);
});
