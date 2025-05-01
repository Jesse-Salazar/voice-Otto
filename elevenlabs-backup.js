const fs = require('fs');
const { updateProject } = require('./googleSheets');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

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

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API Error [${response.status}]: ${errorText}`);
      }

      // Updated buffer handling
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      
      const filename = `audio/audio_${projectId}_${Date.now()}.mp3`;
      await fs.promises.writeFile(filename, buffer);

      await updateProject(projectId, {
        'Status': 'Generated',
        'Audio File URL': filename
      });

      return filename;

    } catch (error) {
      await updateProject(projectId, {
        'Status': 'Error',
        'Notes': `Audio generation failed: ${error.message.substring(0, 100)}`
      });
      throw error;
    }
  }
};