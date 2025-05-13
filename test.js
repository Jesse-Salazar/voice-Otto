const inquirer = require('inquirer');

console.log('Inquirer version:', require('inquirer/package.json').version);
console.log('Prompt exists?', typeof inquirer.prompt === 'function');