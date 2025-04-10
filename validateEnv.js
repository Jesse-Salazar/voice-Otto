// validateEnv.js
require('dotenv/config');

function validateEnvironment() {
  const requiredVars = [
    'BROWSERLESS_API_KEY',
    'VOICE123_EMAIL',
    'VOICE123_PASSWORD',
    'ELEVENLABS_API_KEY',
    'ELEVENLABS_VOICE_ID',
    'GOOGLE_SHEET_ID',
    'GOOGLE_SERVICE_ACCOUNT_EMAIL',
    'GOOGLE_PRIVATE_KEY'
  ];

  const missingVars = requiredVars.filter(varName => !process.env[varName]);

  if (missingVars.length > 0) {
    console.error('❌ Missing environment variables:');
    console.error(missingVars.join('\n'));
    process.exit(1);
  }

  console.log('✅ All environment variables are set');
}

// Export the function
module.exports = validateEnvironment;