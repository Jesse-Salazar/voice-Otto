const { getProjectsByStatus, updateProject } = require("./googleSheets");
const { prompt } = require("inquirer"); // Directly import prompt

// Add at the top of approval.js
console.log('Inquirer path:', require.resolve('inquirer'));

async function approveProjects() {
  const projects = await getProjectsByStatus("Pending Approval");
  
  if (projects.length === 0) {
    console.log("✅ No projects pending approval");
    return;
  }

  for (const project of projects) {
    const answers = await prompt([ // Use directly imported prompt
      {
        type: "confirm",
        name: "approve",
        message: `Approve audio for "${project.title}"?\nAudio URL: ${project.audioUrl}`,
        default: false
      }
    ]);

    await updateProject(project.id, {
      Status: answers.approve ? "Approved" : "Rejected",
      "Reviewed At": new Date().toISOString()
    });
    
    console.log(`📝 Updated status for ${project.id} to ${answers.approve ? 'Approved' : 'Rejected'}`);
  }
}

approveProjects();