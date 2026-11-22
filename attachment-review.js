const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const EXTRACTOR_VERSION = 2;
const TYPES = new Set(["xlsx", "xls", "docx", "pdf", "txt"]);
const digest = value => createHash("sha256").update(value).digest("hex");
const digestShape = /^[a-f0-9]{64}$/;

function safeName(filename) {
  return typeof filename === "string" && filename.length <= 255 && filename !== "." && filename !== ".." &&
    !/[\\/\u0000-\u001f\u007f]/u.test(filename) && filename === path.basename(filename);
}

async function readBytes(filename) {
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("Attachment is not a regular file or exceeds 8 MiB");
    const bytes = Buffer.alloc(Math.min(stat.size + 1, MAX_FILE_BYTES + 1));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size || (await handle.stat()).mtimeMs !== stat.mtimeMs) {
      throw new Error("Attachment changed while being read");
    }
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function parseBytes(bytes, type) {
  const python = process.env.ATTACHMENT_PYTHON || "python3";
  return new Promise((resolve, reject) => {
    const worker = spawn(python, ["-I", "-B", path.join(__dirname, "attachment-parser.py"), type], {
      cwd: os.tmpdir(), env: { PATH: process.env.PATH || "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"]
    });
    let fault;
    let count = 0;
    const output = [];
    const errors = [];
    let errorCount = 0;
    const stop = message => {
      fault ||= new Error(message);
      worker.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop("Attachment parsing exceeded its time limit"), 12000);
    worker.stdout.on("data", chunk => {
      count += chunk.length;
      if (count > MAX_OUTPUT_BYTES) stop("Attachment extraction exceeded its output limit");
      else output.push(chunk);
    });
    worker.stderr.on("data", chunk => {
      errorCount += chunk.length;
      if (errorCount <= 1024) errors.push(chunk);
    });
    worker.stdin.on("error", () => {});
    worker.on("error", () => { fault ||= new Error("Attachment parser could not start"); });
    worker.on("close", code => {
      clearTimeout(timer);
      if (fault) return reject(fault);
      if (code !== 0) {
        const message = Buffer.concat(errors).toString("utf8").trim().split(/\r?\n/).at(-1);
        return reject(new Error(message || "Attachment parser stopped without a result"));
      }
      try {
        resolve(JSON.parse(Buffer.concat(output).toString("utf8")));
      } catch {
        reject(new Error("Malformed attachment parser response"));
      }
    });
    worker.stdin.end(bytes);
  });
}

function classify(sections) {
  const flags = new Set();
  const rightsFlags = new Set();
  const roles = new Set();
  const languageSignals = new Set();
  const candidateGroups = new Set();
  let candidates = 0;

  const classified = sections.map((section, sectionIndex) => {
    const coordinate = block => /^(?<column>[A-Z]+)(?<row>[1-9]\d*)$/.exec(block.location)?.groups;
    const auditionHeader = text => text.trim().normalize("NFKC") === "试音台词(英)";
    const auditionColumns = section.kind === "worksheet" ? section.blocks.flatMap(block => {
      const cell = coordinate(block);
      return cell && auditionHeader(block.text) ? [cell] : [];
    }).sort((a, b) => Number(a.row) - Number(b.row)) : [];
    let context = "unclassified";
    let group = 0;
    if (section.visibility && section.visibility !== "visible") flags.add("hidden-worksheet");
    if (/^(?:audition |recording )?scripts?\b|^dialogue\b/i.test(section.name || "")) context = "dialogue";
    const blocks = section.blocks.map(block => {
      const cell = auditionColumns.length ? coordinate(block) : null;
      const columnHeader = cell && auditionColumns.findLast(header =>
        header.column === cell.column && Number(header.row) < Number(cell.row));
      const lines = block.text.split(/[\r\n\f]+/u).filter(line => line.trim()).map(source => {
        const text = source.trim();
        const heading = /^(?:(?:audition |recording )?script|dialogue|recording lines)(?:\s+(?:[A-Z]|\d+))?\s*:?$/i;
        if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(text)) languageSignals.add("East Asian script");
        if (/\p{Script=Cyrillic}/u.test(text)) languageSignals.add("Cyrillic");
        if (/\p{Script=Arabic}/u.test(text)) languageSignals.add("Arabic");
        if (/\p{Script=Devanagari}/u.test(text)) languageSignals.add("Devanagari");
        if (/\b(?:the|hello|please|you|welcome|thank)\b/i.test(text)) languageSignals.add("English signal");
        if (/\b(?:hola|gracias|buenos días|bienvenidos|usted)\b/i.test(text)) languageSignals.add("Spanish signal");
        if (/\b(?:bonjour|merci|bienvenue|s'il vous plaît)\b/i.test(text)) languageSignals.add("French signal");
        if ((text.match(/\b(?:english|spanish|french|mandarin|german|japanese|arabic)\b/gi) || [])
          .map(word => word.toLowerCase()).filter((word, index, list) => list.indexOf(word) === index).length > 1) {
          flags.add("possible-multilingual");
        }
        if (/\b(?:permanent(?:ly)?|in perpetuity|perpetual(?:ly)?|forever|indefinitely)\b/i.test(text)) rightsFlags.add("Permanent usage");
        if (/\bsub[ -]?licen[cs](?:e|ed|es|ing|able|ee|ees)\b/i.test(text)) rightsFlags.add("Voice-data sublicensing");
        if (/\b(?:tts|synthetic voice|voice cloning|text[ -]to[ -]speech|voice model)\b/i.test(text) &&
            /\b(?:authori[sz]\w*|license|licence|consent|usage rights|grant\w*)\b/i.test(text)) {
          rightsFlags.add("TTS or synthetic-voice authorization");
        }

        let kind = auditionColumns.length ? "unclassified" : context;
        let role;
        if (cell && auditionHeader(block.text)) {
          kind = "heading";
        } else if (heading.test(text)) {
          context = "dialogue";
          group++;
          kind = "heading";
        } else if (/^(?:notes?|metadata|reference|unrelated|contact|budget)\b\s*:/i.test(text)) {
          kind = context = "unrelated";
        } else if (/\b(?:sub[ -]?licen[cs]\w*|in perpetuity|usage rights|voice data|authori[sz]\w*|license terms|licensing)\b/i.test(text)) {
          kind = "licensing";
          if (/^(?:licen[cs](?:e|ing)|terms|rights|authorization)\b/i.test(text)) context = kind;
        } else if (/^(?:instructions?|directions?|please (?:record|read|refer|use|submit)|see (?:the|attached)|(?:audition|recording) instructions)\b/i.test(text)) {
          kind = "instruction";
          if (/^(?:instructions?|directions?|(?:audition|recording) instructions)\b/i.test(text)) context = kind;
        } else if (/^(?:role description|character description|role profile|project description|synopsis)\b/i.test(text)) {
          kind = context = "role-description";
        } else if (columnHeader || (!auditionColumns.length && !["licensing", "unrelated", "role-description"].includes(context))) {
          if (columnHeader) kind = "dialogue";
          const speaker = text.match(/^([\p{L}][\p{L}\p{N} _-]{0,30}):\s+(\S.*)$/u);
          if (speaker) {
            role = speaker[1].trim();
            roles.add(role.toLowerCase());
            kind = "dialogue";
          } else if (/^(?:“.+”|".+")$/u.test(text)) kind = "dialogue";
        }
        if (kind === "dialogue") {
          candidates++;
          candidateGroups.add(columnHeader
            ? `${sectionIndex}:${columnHeader.column}${columnHeader.row}` : `${sectionIndex}:${group}`);
        }
        return { text: source, kind: kind === "dialogue" ? "dialogue-candidate" : kind, ...(role ? { role } : {}) };
      });
      return { ...block, lines };
    });
    return { ...section, blocks };
  });

  if (!candidates) flags.add("no-clear-recording-dialogue");
  if (candidates === 1) flags.add("possibly-incomplete");
  if (candidateGroups.size > 1) flags.add("multiple-candidate-sections");
  if (roles.size > 1) flags.add("multiple-roles");
  if (languageSignals.size > 1) flags.add("possible-multilingual");
  if (classified.some(section => section.blocks.some(block => block.lines.some(line => line.kind === "unclassified")))) flags.add("unclassified-material");
  if (rightsFlags.size) flags.add("voice-rights-unresolved");
  return { sections: classified, reviewFlags: [...flags], unresolvedRights: [...rightsFlags], candidateLines: candidates };
}

async function extractAttachment(file) {
  const filename = path.basename(file);
  const type = path.extname(filename).slice(1).toLowerCase();
  if (!safeName(filename) || !TYPES.has(type)) {
    throw new Error(type === "doc" ? "Legacy DOC is unsupported; obtain a reviewed DOCX or TXT copy" : "Unsupported attachment format");
  }
  const bytes = await readBytes(file);
  if (!bytes.length) throw new Error("Attachment is empty");
  const { sections, warnings } = await parseBytes(bytes, type);
  const review = classify(sections);
  return {
    status: "Needs Review",
    provenance: { filename, type: type.toUpperCase(), bytes: bytes.length, sha256: digest(bytes),
      extractionSha256: digest(JSON.stringify(sections)), extractorVersion: EXTRACTOR_VERSION },
    ...review, warnings
  };
}

function validSources(sources) {
  return Array.isArray(sources) && sources.length > 0 && sources.length <= 4 &&
    sources.every(source => safeName(source?.filename) && TYPES.has(path.extname(source.filename).slice(1).toLowerCase()) &&
      source.type === path.extname(source.filename).slice(1).toUpperCase() &&
      Number.isInteger(source.bytes) && source.bytes > 0 && source.bytes <= MAX_FILE_BYTES &&
      typeof source.sha256 === "string" && digestShape.test(source.sha256) &&
      typeof source.extractionSha256 === "string" && digestShape.test(source.extractionSha256) &&
      source.extractorVersion === EXTRACTOR_VERSION) &&
    new Set(sources.map(source => source.filename.normalize("NFC").toLowerCase())).size === sources.length;
}

async function verifyAttachmentSources(voice123Id, attachmentReview, root = process.env.VOICE_OTTO_ATTACHMENT_DIR) {
  if (attachmentReview?.outcome !== "reviewed") return;
  if (!/^[A-Z0-9]+$/.test(voice123Id) || !root || !validSources(attachmentReview.sources)) {
    throw new Error("Attachment review requires a valid local source manifest and configured attachment directory");
  }
  const parent = await fs.realpath(root);
  const directory = path.join(parent, voice123Id);
  if (await fs.realpath(directory) !== directory) throw new Error("Project attachment directory may not be a symlink");
  for (const source of attachmentReview.sources) {
    const { provenance } = await extractAttachment(path.join(directory, source.filename));
    if (Object.keys(provenance).some(key => provenance[key] !== source[key])) {
      throw new Error("Project attachment or extraction changed; obtain a fresh project review");
    }
  }
}

if (require.main === module) {
  const [file] = process.argv.slice(2);
  if (!file || process.argv.length !== 3) {
    console.error("Usage: node attachment-review.js LOCAL_ATTACHMENT");
    process.exitCode = 1;
  } else {
    extractAttachment(file).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => {
      console.error("Attachment rejected:", error.message);
      process.exitCode = 1;
    });
  }
}

module.exports = { extractAttachment, validSources, verifyAttachmentSources, MAX_FILE_BYTES };
