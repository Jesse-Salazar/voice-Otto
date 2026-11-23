const ORIGIN = "https://voice123.com";
const PROJECT_PATH = /^\/projects\/([a-z0-9]+)\/[^/]+\/specs\/?$/i;

function projectIdentity(value) {
  try {
    const url = new URL(value);
    const match = url.origin === ORIGIN && !url.username && !url.password && url.pathname.match(PROJECT_PATH);
    return match ? { id: match[1].toUpperCase(), url: ORIGIN + url.pathname } : null;
  } catch {
    return null;
  }
}

function projectLinks(origin, source) {
  const pattern = new RegExp(source, "i");
  const projects = new Map();
  for (const link of document.links) {
    const match = link.origin === origin && !link.username && !link.password && link.pathname.match(pattern);
    if (!match || !link.getClientRects().length || getComputedStyle(link).visibility !== "visible" ||
        link.closest('[hidden], [aria-hidden="true"]')) continue;
    const id = match[1].toUpperCase();
    const row = link.closest(".vdl-invite-list-item, li, tr, [role='listitem']") || link;
    const text = row.innerText || "";
    const status = /\brevision requested\b|\brequested (?:a )?revision\b/i.test(text)
      ? "Revision requested"
      : /\breceived invitation\b|\binvitation received\b|\bnew invitation\b/i.test(text)
        ? "New invitation"
        : "Unknown";
    const previous = projects.get(id);
    if (previous) {
      if (status !== "Unknown") previous.statuses.add(status);
      continue;
    }
    const meta = [...row.querySelectorAll(".item-info:not(.small-icon)")].map(el => el.innerText.trim());
    projects.set(id, {
      id,
      url: origin + link.pathname,
      title: (row.querySelector(".item-title")?.innerText || link.innerText || id).trim() || id,
      deadline: meta.find(value => /remaining/i.test(value)) || "No deadline found",
      statuses: new Set(status === "Unknown" ? [] : [status])
    });
  }
  return [...projects.values()].map(({ statuses, ...project }) => ({
    ...project,
    invitationStatus: statuses.size === 1 ? [...statuses][0] : "Unknown",
    conflictingStatus: statuses.size > 1
  }));
}

function readSpecs() {
  const visible = element => element?.getClientRects().length &&
    getComputedStyle(element).visibility === "visible" && !element.closest('[hidden], [aria-hidden="true"]');
  const specs = document.querySelector(".project-management.specs, .project-specs, .project-info.specs");
  const root = specs || document.querySelector("main") || document.body;
  const labelPattern = /^script for custom audition\s*:?$/i;
  const isLabel = element => visible(element) && labelPattern.test(element.innerText?.trim() || "");
  const rowSelector = ".field-item, [role='row'], tr, dl";
  const valueSelector = ".field-value-text, .field-value, .vdl-expandable-text, dd";
  const labels = [...root.querySelectorAll("span, label, dt, th, div, p, strong, b, [role='rowheader']")]
    .filter(element => isLabel(element) && ![...element.querySelectorAll("*")].some(isLabel));
  const values = [];
  for (const label of labels) {
    const row = label.closest(rowSelector);
    // Without a known row, accept only a typed value immediately beside the label.
    for (let wrapper = label; wrapper && wrapper !== row && wrapper !== root; wrapper = row ? wrapper.parentElement : null) {
      let sibling = wrapper.nextElementSibling;
      while (sibling && !visible(sibling)) sibling = sibling.nextElementSibling;
      if (!sibling) continue;
      const candidates = sibling.matches(valueSelector) ? [sibling] :
        [...sibling.querySelectorAll(valueSelector)].filter(element =>
          visible(element) && !sibling.contains(element.parentElement.closest(valueSelector)));
      if (candidates.length === 1) {
        const value = candidates[0].innerText?.trim();
        if (value && !labelPattern.test(value) && sibling.innerText?.trim() === value &&
            !sibling.matches("a, button, [role='button']") &&
            !sibling.querySelector("a[download], button, [role='button']")) values.push(value);
      }
      break;
    }
  }

  const extension = /\.(xlsx|xls|pdf|docx|doc|txt)(?=$|[\s?#"')\],.;])/gi;
  const fileTypes = text => [...(text || "").matchAll(extension)].map(match => match[1].toUpperCase());
  const attachments = new Map();
  const control = "a, button, [role='button'], [role='link'], [download], [onclick], [tabindex='0']";
  function record(element, types) {
    const owner = element.closest("a, button, [role='button'], [role='link']") || element.closest(control) || element;
    const found = attachments.get(owner) || new Set();
    types.forEach(type => found.add(type));
    attachments.set(owner, found);
  }
  for (const element of root.querySelectorAll(control + ", [data-filename], [data-file-name]")) {
    if (!visible(element)) continue;
    const labels = ["title", "aria-label", "download", "data-filename", "data-file-name"].map(name => element.getAttribute(name));
    if (element.matches("a[href]")) {
      try {
        labels.push(decodeURIComponent(new URL(element.href).pathname));
      } catch {
        // The visible label may still identify the attachment.
      }
    }
    const types = labels.flatMap(fileTypes);
    if (types.length || element.hasAttribute("download") ||
        labels.some(label => /^(?:download|view) (?:the )?(?:attachment|file)\b/i.test(label || ""))) record(element, types);
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const types = fileTypes(node.textContent);
    if (visible(node.parentElement) && (types.length ||
        (node.parentElement.closest(control) && /^(?:download|view) (?:the )?(?:attachment|file)\b/i.test(node.textContent.trim())))) {
      record(node.parentElement, types);
    }
  }
  // Only explicit status messages count. Specs prose, counters and controls
  // cannot establish that the project is accepting proposals.
  const lines = [...root.querySelectorAll('[role="status"], [role="alert"], .project-status, .proposal-status, .invitation-toast')]
    .filter(element => visible(element) && !element.closest(rowSelector))
    .flatMap(element => (element.innerText || "").split("\n").map(line => line.trim()));
  const closed = lines.some(line =>
    /^(?:this project is )?(?:no longer|not(?: currently)?) accepting (?:new )?proposals[.!]?$/i.test(line) ||
    /^(?:this )?project (?:is |has been )?closed[.!]?$/i.test(line));
  const open = lines.some(line =>
    /^(?:(?:this )?project is )?(?:accepting (?:new )?proposals|open (?:for|to) proposals)[.!]?$/i.test(line));
  const fieldText = labels.length === 1 && values.length === 1 ? values[0] : null;
  const missing = !labels.length || (fieldText && /^(?:n\s*\/?\s*a|none|not (?:provided|applicable|required)|[-—]+)[.!]?$/i.test(fieldText));
  const acceptInvite = [...root.querySelectorAll("button, [role='button']")].some(element =>
    visible(element) && /^accept invite$/i.test(element.innerText?.trim() || ""));
  const rightsText = (root.innerText || "").replace(/\s+/g, " ");
  const synthetic = /\b(?:tts|text[ -]to[ -]speech|synthetic voice|voice clon(?:e|ing)|AI[ -]generated voice|voice model)\b/i.test(rightsText);
  const voiceData = /\b(?:voice data|voice recordings|recorded voice|voice rights)\b/i.test(rightsText);
  const rightsFlags = [];
  if ((synthetic || voiceData) && /\b(?:permanent(?:ly)?|perpetual(?:ly)?|in perpetuity|forever|indefinitely)\b/i.test(rightsText)) {
    rightsFlags.push("Permanent usage");
  }
  if ((synthetic || voiceData) && /\bsub[ -]?licen[cs](?:e|ed|es|ing|able|ee|ees)\b/i.test(rightsText)) {
    rightsFlags.push("Voice-data sublicensing");
  }
  if (synthetic && /\b(?:authori[sz](?:ation|e|ed)|consent|licen[cs]e|grant(?:s|ed|ing)? the right)\b/i.test(rightsText)) {
    rightsFlags.push("TTS or synthetic-voice authorization");
  }
  return {
    rightsFlags,
    fieldStatus: missing ? "Missing" : fieldText ? "Valid" : "Needs Review",
    fieldText: missing ? null : fieldText,
    attachments: [...attachments].map(([element, types]) => ({ types: [...types].sort(), element: element.localName })),
    invitationStatus: lines.some(line => /^revision requested$/i.test(line)) ? "Revision requested" :
      acceptInvite || lines.some(line => /^(?:received invitation|invitation received)$/i.test(line)) ? "New invitation" : "Unknown",
    proposalEligibility: open === closed ? "Unknown" : open ? "Yes" : "No"
  };
}

function auditionMaterialNeedsReview(text) {
  return /\.(?:xlsx|xls|pdf|docx|doc|txt)\b|\b(?:attached|attachments?|spreadsheet)\b|\b(?:role|project|character|job) description\b|\b(?:see|refer to|read from|follow|use)\b.{0,60}\b(?:brief|specs|document|link|provided script|script below|script above)\b|\b(?:script|copy|lines) (?:will (?:be sent|follow|be provided)|to (?:come|follow))\b/i.test(text) ||
      /^(?:please\s+)?(?:send|provide|submit|record)\b.{0,100}\b(?:a sample|an audition|a demo|your demo)\b/i.test(text) ||
      text.length < 50;
}

function auditionReadiness(details, invitationStatus) {
  if (invitationStatus === "Revision requested") return { status: "Needs Review", reason: "Revision request requires manual review" };
  if (invitationStatus !== "New invitation") return { status: "Needs Review", reason: "Invitation status requires review" };
  if (details.proposalEligibility === "No") return { status: "Needs Review", reason: "Project is closed to proposals" };
  if (details.proposalEligibility !== "Yes") return { status: "Needs Review", reason: "Proposal eligibility is not confirmed" };
  if (details.fieldStatus !== "Valid") return { status: "Needs Review", reason: "Audition field is missing or ambiguous" };
  if (details.attachments.length || auditionMaterialNeedsReview(details.fieldText)) {
    return { status: "Needs Review", reason: "Audition material may be incomplete" };
  }
  if (details.rightsFlags?.length) return { status: "Needs Review", reason: "Voice rights require manual review" };
  return { status: "Processing", reason: null };
}

module.exports = { ORIGIN, PROJECT_PATH, projectIdentity, projectLinks, readSpecs, auditionReadiness, auditionMaterialNeedsReview };
