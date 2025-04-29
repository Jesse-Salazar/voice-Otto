require("dotenv").config({ path: ".env" });
const validateEnv = require("./validateEnv"); // Now properly imported
const voice123 = require("./voice123");
const voiceBuild = require("./elevenlabs");
const { updateProject } = require("./googleSheets");

// Helper function
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  try {
    console.log("🚀 Starting Voice123 Automation");

    // 1. Login and extract project details
    await voice123.checkInvites();
    await voiceBuild.generateAudio();

    // 2. Sent to Eleven Labs for audio generation
    console.log("\n🏁 All projects processed successfully");
  } catch (error) {
    console.error("🔥 Critical error:", error);
    process.exit(1);
  }
}

validateEnv();
main();
