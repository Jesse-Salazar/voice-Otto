const http = require("node:http");
const path = require("node:path");

function authorityRequest(socketPath, request) {
  if (!path.isAbsolute(socketPath || "")) return Promise.reject(new Error("An absolute local authority socket is required"));
  return new Promise((resolve, reject) => {
    const message = JSON.stringify(request);
    // Recheck OS socket access on each request instead of reusing a connection
    // opened before a permissions change.
    const call = http.request({ socketPath, path: "/authorize", method: "POST", agent: false,
      headers: { "Content-Length": Buffer.byteLength(message) } }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("error", reject);
      response.on("data", chunk => {
        body += chunk;
        if (body.length > 8192) call.destroy(new Error("Invalid authority response"));
      });
      response.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (response.statusCode !== 200 || !Object.hasOwn(data, "result")) throw new Error(data.error || "Authority denied request");
          resolve(data.result);
        } catch (error) { reject(error); }
      });
    });
    call.on("error", () => reject(new Error("Authority unavailable or response lost; do not retry a claim blindly")));
    call.setTimeout(3000, () => call.destroy());
    call.end(message);
  });
}

// Same handle shape as the existing permit reader. No production entry point selects this adapter.
async function openAuthorityPermit(operation, { permitId, socketPath }) {
  const request = (action, binding, attemptId) => authorityRequest(socketPath, {
    action, operation, permitId, binding: binding && { ...binding, audioSha256: binding.audioSha256 ?? null }, attemptId
  });
  const permit = Object.freeze(await request("open"));
  return {
    permit,
    validate: (binding, attemptId) => request("validate", binding, attemptId),
    claim: (binding, attemptId) => request("claim", binding, attemptId)
  };
}

module.exports = { authorityRequest, openAuthorityPermit };
