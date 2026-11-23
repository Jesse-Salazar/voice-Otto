const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { sha256, ApprovalError } = require("./approval-evidence");

async function stageAudio(file) {
  const extension = path.extname(file).toLowerCase();
  if (![".mp3", ".wav"].includes(extension)) throw new ApprovalError("Expected an upload-ready MP3 or WAV file");
  const stat = await fs.stat(file);
  if (!stat.isFile() || !stat.size || stat.size > 100 * 1024 * 1024) throw new ApprovalError("Invalid upload-ready file size");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "voice-otto-approval-"));
  const staged = path.join(directory, "audition" + extension);
  const cleanup = () => fs.rm(directory, { recursive: true, force: true });
  try {
    await fs.copyFile(file, staged);
    await fs.chmod(staged, 0o400);
    return { file: staged, digest: async () => sha256(await fs.readFile(staged)), cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

module.exports = { stageAudio };
