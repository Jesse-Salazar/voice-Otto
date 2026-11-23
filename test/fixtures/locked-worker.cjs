const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const url = "https://voice123.com/projects/LOCAL/fixture/specs";

function worker(kind, onEnter) {
  const filename = path.join(__dirname, "../..", kind === "generation" ? "elevenlabs.js" : "voice123-submission.js");
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  const mocks = {
    "./execution-permit": { openPermit: async () => ({ permit: { projectId: "LOCAL", trackingId: "fixture" } }) },
    "./googleSheets": {
      getApprovalProject: kind === "generation" ? onEnter : () => assert.fail("Unexpected approval read"),
      updateProject: () => assert.fail("Unexpected Sheets write")
    },
    "./approval-audio": { stageAudio: kind === "submission" ? onEnter : () => assert.fail("Unexpected staging") },
    "./s3": { uploadFile: () => assert.fail("Unexpected AWS call") }
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module, URL, Buffer, __dirname: path.dirname(filename),
    process: { env: { DRY_RUN: "false", ENABLE_PAID_GENERATION: "true", ENABLE_VOICE123_SUBMISSION: "true" } },
    require: key => Object.hasOwn(mocks, key) ? mocks[key] : realRequire(key)
  }, { filename });
  return kind === "generation" ? module.exports.generateAudio("fixture", "dummy script") :
    module.exports.submitApprovedAudio(url, "/dummy.mp3", { connect: () => assert.fail("Unexpected browser") });
}

if (require.main === module && process.send) {
  worker(process.argv[2], () => {
    process.send("entered");
    return new Promise(() => {});
  }).catch(error => { process.send({ error: error.message }); process.exitCode = 1; });
}

module.exports = { worker };
