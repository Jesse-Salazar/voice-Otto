const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { readClarifications } = require("./clarification-log");

function localPaths(root) {
  return {
    ATTACHMENT_PYTHON: path.join(root, "python", "bin", "python"),
    VOICE_OTTO_ATTACHMENT_DIR: path.join(root, "attachments"),
    VOICE_OTTO_CLARIFICATION_LOG: path.join(root, "clarification", "journal.jsonl"),
    VOICE_OTTO_CLARIFICATION_SOURCE_DIR: path.join(root, "clarification", "source-material")
  };
}

async function validateLocalPaths(env, root = path.join(__dirname, ".voice-otto-local")) {
  if (!path.isAbsolute(root) || await fs.realpath(root) !== root) throw new Error("Invalid private review root");
  const expected = localPaths(root);
  for (const [key, value] of Object.entries(expected)) {
    if (env[key] !== value) throw new Error(`Invalid local configuration: ${key}`);
  }
  const directories = [root, path.join(root, "python"), path.join(root, "python", "bin"), path.join(root, "clarification"),
    expected.VOICE_OTTO_ATTACHMENT_DIR, expected.VOICE_OTTO_CLARIFICATION_SOURCE_DIR];
  for (const directory of directories) {
    const metadata = await fs.lstat(directory);
    if (!metadata.isDirectory() || await fs.realpath(directory) !== directory) throw new Error("Unexpected local review directory");
    await fs.access(directory, constants.R_OK | constants.X_OK);
  }
  for (const directory of [root, expected.VOICE_OTTO_ATTACHMENT_DIR, path.join(root, "clarification"), expected.VOICE_OTTO_CLARIFICATION_SOURCE_DIR]) {
    if ((await fs.stat(directory)).mode & 0o077) throw new Error("Local review directories must be private");
  }
  const journal = await fs.lstat(expected.VOICE_OTTO_CLARIFICATION_LOG);
  if (!journal.isFile() || journal.mode & 0o077) throw new Error("Clarification journal must be a private regular file");
  await fs.access(expected.ATTACHMENT_PYTHON, constants.X_OK);
  return expected;
}

function verifyInterpreter(executable, prefix, env, requirements) {
  const probe = spawnSync(executable, ["-I", "-B", "-c", [
    "import json, sys, os, importlib, importlib.metadata",
    "packages = json.loads(sys.argv[1])",
    "assert os.path.realpath(sys.prefix) == sys.argv[2] and sys.prefix != sys.base_prefix",
    "for name, version in packages.items():",
    "    importlib.import_module(name)",
    "    assert importlib.metadata.version(name) == version",
    "print(json.dumps({'python': sys.version.split()[0], 'dependencies': packages}))"
  ].join("\n"), JSON.stringify(requirements), prefix], {
    encoding: "utf8", timeout: 5000, maxBuffer: 32768, env: { PATH: env.PATH || "/usr/bin:/bin" }
  });
  if (probe.status !== 0) throw new Error("The configured attachment virtual environment is missing pinned parser dependencies");
  return JSON.parse(probe.stdout);
}

async function verifyLocalConfiguration(env, root = path.join(__dirname, ".voice-otto-local")) {
  const paths = await validateLocalPaths(env, root);
  const pinned = (await fs.readFile(path.join(__dirname, "requirements-attachments.txt"), "utf8")).trim().split(/\r?\n/);
  const requirements = Object.fromEntries(pinned.map(line => {
    const match = line.match(/^([a-z0-9]+)==([0-9.]+)$/i);
    if (!match) throw new Error("Expected pinned attachment dependencies");
    return [match[1], match[2]];
  }));
  const runtime = verifyInterpreter(paths.ATTACHMENT_PYTHON, path.join(root, "python"), env, requirements);
  const records = await readClarifications(paths.VOICE_OTTO_CLARIFICATION_LOG);
  return { ...runtime, privatePathsVerified: true, journalIntegrityVerified: true, clarificationRecords: records.length };
}

module.exports = { localPaths, validateLocalPaths, verifyLocalConfiguration };
