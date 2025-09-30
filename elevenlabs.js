const fs = require("fs-extra");
const path = require("path");
const { updateProject } = require("./googleSheets");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));
const { uploadFile } = require("./s3");

// Voice parameter configuration
const VOICE_SETTINGS = {
  stability: parseFloat(process.env.ELEVENLABS_STABILITY) || 0.6,
  similarity_boost: parseFloat(process.env.ELEVENLABS_SIMILARITY) || 0.85,
  style: parseFloat(process.env.ELEVENLABS_STYLE_EXAGGERATION) || 0.5,
  speed: parseFloat(process.env.ELEVENLABS_SPEED) || 1.12,
  speaker_boost: process.env.ELEVENLABS_SPEAKER_BOOST === "true" || true,
};

module.exports = {
  async generateAudio(projectId, text) {
    let filename;
    try {
      await updateProject(projectId, { Status: "Processing" });

      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,
        {
          method: "POST",
          headers: {
            "xi-api-key": process.env.ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify({
            text: text,
            model_id:
              process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2",
            voice_settings: VOICE_SETTINGS,
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API Error [${response.status}]: ${errorText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Stable filename used for both local copy and S3 key
      filename = `audio_${projectId}_${Date.now()}.mp3`;

      // Optionally save a local copy immediately so user can edit before any upload.
      // Controlled by env var SAVE_LOCAL_AUDIO (default: enabled). Writes to ./tmp_audio.
      try {
        if (process.env.SAVE_LOCAL_AUDIO !== "false") {
          const tmpDir = path.resolve(__dirname, "tmp_audio");
          fs.ensureDirSync(tmpDir);
          // Keep filename safe; allow short titles in future if provided
          const localPath = path.join(tmpDir, filename);
          fs.writeFileSync(localPath, buffer);
          console.log(`WROTE_LOCAL_COPY ${localPath}`);
        }
      } catch (e) {
        console.warn(
          "Failed to write local copy for editing:",
          e && e.message ? e.message : e
        );
      }

      const s3Url = await uploadFile(buffer, filename, "audio/mpeg");

      await updateProject(projectId, {
        Status: "Pending Approval",
        "Audio File URL": s3Url,
        "Voice Settings": JSON.stringify(VOICE_SETTINGS),
      });

      return filename;
    } catch (error) {
      try {
        await updateProject(projectId, {
          Status: "Error",
          Notes: `Audio generation failed: ${String(error.message || error).substring(
            0,
            200
          )}`,
        });
      } catch (e) {
        console.warn("Failed to update project status after error:", e.message);
      }

      throw error;
    }
  },
};
