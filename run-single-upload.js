const sheets = require('./googleSheets');
const s3 = require('./s3');
const path = require('path');
const fs = require('fs');
const { uploadAudio } = require('./voice123');

(async () => {
  try {
    const projects = await sheets.getProjectsByStatus('Approved');
    if (!projects || projects.length === 0) {
      console.log('NO_APPROVED');
      process.exit(0);
    }
    const project = projects[0];
    console.log('Selected project:', project.id, project.title);

    const parsed = new URL(project.audioUrl);
    const filename = path.basename(parsed.pathname);
    const localPath = path.join(__dirname, 'tmp_audio', filename);

    // Ensure tmp_audio exists
    fs.mkdirSync(path.join(__dirname, 'tmp_audio'), { recursive: true });

    console.log('Downloading from S3 to', localPath);

    // s3.downloadFile expects the object key (not full URL)
    const key = parsed.pathname.replace(/^\//, '');
    try {
      const buffer = await s3.downloadFile(key);
      fs.writeFileSync(localPath, buffer);
    } catch (err) {
      console.warn('S3 download failed, attempting HTTPS fallback:', err && err.message ? err.message : err);
      // Fallback: try to fetch the file directly via HTTPS
      await new Promise((resolve, reject) => {
        const https = require('https');
        const file = fs.createWriteStream(localPath);
        https.get(project.audioUrl, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          res.pipe(file);
          file.on('finish', () => file.close(resolve));
        }).on('error', (e) => {
          fs.unlinkSync(localPath, { force: true });
          reject(e);
        });
      });
    }

    console.log('Calling uploadAudio for', project.url, localPath);
    const result = await uploadAudio(project.url, localPath);
    console.log('upload result:', result);
  } catch (e) {
    console.error('Runner error:', e && e.message ? e.message : e);
    process.exit(1);
  }
})();
