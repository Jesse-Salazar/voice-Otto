const fs = require('fs');
const fetch = require('node-fetch');
const { updateProject } = require('./googleSheets');

module.exports = {
  async generateAudio(projectId, text) {
    try {
      await updateProject(projectId, { 'Status': 'Processing' });

      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': process.env.ELEVENLABS_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            text: text,
            voice_settings: {
              stability: 0.7,
              similarity_boost: 0.8
            }
          })
        }
      );

      if (!response.ok) throw new Error(await response.text());

      const buffer = await response.buffer();
      const filename = `audio_${projectId}_${Date.now()}.mp3`;
      fs.writeFileSync(filename, buffer);

      await updateProject(projectId, {
        'Status': 'Generated',
        'Audio File URL': filename
      });

      return filename;

    } catch (error) {
      await updateProject(projectId, {
        'Status': 'Error',
        'Notes': `Audio generation failed: ${error.message}`
      });
      throw error;
    }
  }
};