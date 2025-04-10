/*
require('dotenv/config');

const fs = require('fs');
const fetch = require('node-fetch');

const generateAudio = async (text) => {
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

  if (!response.ok) throw new Error(`API Error: ${response.statusText}`);
  
  const buffer = await response.buffer();
  const filename = `audio_${Date.now()}.mp3`;
  fs.writeFileSync(filename, buffer);
  return filename;
};

// Example usage
generateAudio("Sample script text")
  .then(filename => console.log(`Audio saved as: ${filename}`))
  .catch(console.error);