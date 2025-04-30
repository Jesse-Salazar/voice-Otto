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
    const projects = await voice123.checkInvites();
    
    // 2. Process audio for each project
    for (const project of projects) {
      try {
        if (project.script && project.id) {
          await voiceBuild.generateAudio(project.id, project.script);
        }
      } catch (error) {
        console.error(`🚧 Project ${project.id} failed:`);
        console.error(error);
        await updateProject(project.id, {
          'Status': 'Error',
          'Notes': error.message
        });
      }
    };

    console.log("\n🏁 All projects processed successfully");
  } catch (error) {
    console.error("🔥 Critical error:", error);
    process.exit(1);
  }
}

validateEnv();
main();
