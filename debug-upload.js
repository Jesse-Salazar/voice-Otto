const { uploadAudio } = require('./voice123');

(async () => {
  const testUrl = process.env.VOICE123_TEST_URL; // set to a known project url
  const testAudio = process.env.VOICE123_TEST_AUDIO; // set to a local audio path
  if (!testUrl || !testAudio) {
    console.error('Please set VOICE123_TEST_URL and VOICE123_TEST_AUDIO env vars');
    process.exit(2);
  }

  try {
    const res = await uploadAudio(testUrl, testAudio);
    console.log('uploadAudio result:', res);
  } catch (e) {
    console.error('uploadAudio threw:', e);
    process.exit(1);
  }
})();
