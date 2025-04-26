require("dotenv").config({ path: ".env" });
const validateEnv = require('./validateEnv'); // Now properly imported
const voice123 = require('./voice123');
const { generateAudio } = require('./elevenlabs');
const { updateProject } = require('./googleSheets');

// Helper function
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  try {
    console.log('🚀 Starting Voice123 Automation');
    
    // 1. Login and get projects
    const projects = await voice123.checkInvites();
    console.log(`📋 Found ${projects.length} projects to process`);
    
    // 2. Process each project
    for (const [index, project] of projects.entries()) {
      console.log(`\n--- Processing Project ${index + 1}/${projects.length} ---`);
      console.log(`🆔 ID: ${project.id}`);
      console.log(`📝 Script Length: ${project.script?.length || 0} chars`);
      
      try {
        // Update status in sheet
        await updateProject(project.id, { 
          'Status': 'Processing',
          'Last Updated': new Date().toISOString() 
        });

        // Generate audio (implement your ElevenLabs logic)
        console.log('🔊 Generating audio...');
        const audioFile = await generateAudio(project.script);
        console.log(`✅ Audio saved: ${audioFile}`);

        // Submit to Voice123 (you'll implement this later)
        // console.log('📤 Submitting audio...');
        // await submitToVoice123(project.id, audioFile);

        // Mark as completed
        await updateProject(project.id, {
          'Status': 'Completed',
          'Audio File': audioFile,
          'Submitted At': new Date().toISOString()
        });

      } catch (error) {
        console.error(`❌ Failed project ${project.id}:`, error.message);
        await updateProject(project.id, {
          'Status': 'Error',
          'Error': error.message.slice(0, 200) // Truncate long errors
        });
      }
      
      await sleep(3000); // Rate limiting between projects
    }

    console.log('\n🏁 All projects processed successfully');

  } catch (error) {
    console.error('🔥 Critical error:', error);
    process.exit(1);
  }
}

validateEnv();
main();