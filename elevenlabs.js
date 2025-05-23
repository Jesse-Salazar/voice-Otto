const fs = require("fs");
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

      const filename = `audio_${projectId}_${Date.now()}.mp3`;
      const s3Url = await uploadFile(buffer, filename, "audio/mpeg");

      await updateProject(projectId, {
        Status: "Pending Approval",
        "Audio File URL": s3Url,
        "Voice Settings": JSON.stringify(VOICE_SETTINGS), // Optional: Store settings
      });

      return filename;
    } catch (error) {
      await updateProject(projectId, {
        Status: "Error",
        Notes: `Audio generation failed: ${error.message.substring(0, 100)}`,
      });

      // Delete partial file if exists
      if (filename) {
        await s3Client
          .send(
            new DeleteObjectCommand({
              Bucket: process.env.AWS_BUCKET_NAME,
              Key: filename,
            })
          )
          .catch((deleteErr) => {
            console.error("Failed to clean up failed upload:", deleteErr);
          });
      }
      throw error;
    }
  },
};
