// Route legacy runners through the guarded upload workflow.
require("./upload")().catch(error => { console.error(error.message); process.exitCode = 1; });
