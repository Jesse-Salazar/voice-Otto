const { getProjectsByStatus, updateProject } = require("./googleSheets");
const { downloadFile } = require("./s3");
const { uploadAudio } = require("./voice123");
const fs = require("fs");
const path = require("path");

async function processApproved() {
  const projects = await getProjectsByStatus("Approved");
  const tempDir = "./tmp_audio";

  for (const project of projects) {
    let filePath;
    try {
      // Validate project has audio file
      if (!project.audioFileName) {
        throw new Error("Missing audio file reference");
      }

      // Download from S3
      const audioData = await downloadFile(project.audioFileName);

      // Ensure temp directory exists
      await fs.promises.mkdir(tempDir, { recursive: true });
      filePath = path.join(tempDir, project.audioFileName);

      // Write to temp file
      await fs.promises.writeFile(filePath, audioData);

      const absolutePath = path.resolve(filePath);
      if (!fs.existsSync(absolutePath)) {
        throw new Error(
          `❌ Critical Error: Temp file not created at ${absolutePath}`
        );
      }

      // Upload to Voice123
      const success = await uploadAudio(project.url, filePath);

      // Update status
      await updateProject(project.id, {
        Status: success ? "Uploaded" : "Upload Failed",
        "Uploaded At": new Date().toISOString(),
        ...(success ? {} : { Notes: "Failed to verify upload completion" }),
      });
    } catch (error) {
      console.error(`Error processing ${project.id}:`, error);
      await updateProject(project.id, {
        Status: "Upload Failed",
        Notes: error.message.substring(0, 200),
      });
    } finally {
      // Cleanup temp file
      if (filePath) {
        try {
          await fs.promises.unlink(filePath);
        } catch (cleanupError) {
          console.error("Cleanup failed:", cleanupError);
        }
      }
    }
  }
}

processApproved();