const fs = require("node:fs/promises");
const { parseArgs } = require("node:util");
const { auditionMaterialNeedsReview, auditionReadiness } = require("./voice123-projects");
const { assessSalazarPolicy } = require("./salazar-media-policy");
const { assessSalazarPolicyV2 } = require("./salazar-media-policy-v2");

const invitationStatuses = ["new", "revision_requested", "closed", "withdrawn", "declined", "unknown"];
const proposalStatuses = ["open", "closed", "unknown"];
const scriptStatuses = ["verified_usable", "available", "missing", "unknown"];
const attachmentStatuses = ["none", "required", "unknown"];
const rightsStatuses = ["reviewed_no_concerns", "review_required", "unknown"];
const classifications = ["eligible", "needs_review", "ineligible"];
const channelEvidence = ["voice123", "external"];
const evidenceChoices = {
  scriptLanguage: ["english", "non_english", "mixed"],
  paymentChannel: channelEvidence,
  paymentSecurity: ["secured", "unsecured"],
  paymentTerms: ["platform_standard", "nonstandard"],
  auditionChannel: channelEvidence,
  communicationChannel: channelEvidence,
  transactionChannel: channelEvidence
};

class InputError extends Error {}

function requireObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InputError(label + " must be an object");
  }
  if (fields && Object.keys(value).some(key => !fields.includes(key))) {
    throw new InputError(label + " contains an unexpected field");
  }
}

function readOwnDataObject(value, fields, label) {
  requireObject(value, null, label);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InputError(label + " must be a plain data object");
  }
  const data = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new InputError(label + " must contain only enumerable string-keyed data properties");
    }
    if (!fields.includes(key)) throw new InputError(label + " contains an unexpected field");
    data[key] = descriptor.value;
  }
  return data;
}

function optionalText(value, label) {
  if (value == null) return null;
  if (typeof value !== "string" || !value.trim()) throw new InputError(label + " must be nonempty text or null");
  return value.trim();
}

function readStatus(value, choices, label) {
  if (value == null) return "unknown";
  if (!choices.includes(value)) throw new InputError(label + " has an unsupported status");
  return value;
}

function readDeadline(value, label) {
  if (value == null) return null;
  const format = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
  const parts = typeof value === "string" && value.match(format);
  const time = parts ? Date.parse(value) : NaN;
  const day = parts && new Date(parts.slice(1, 4).join("-") + "T00:00:00Z");
  if (!Number.isFinite(time) || day.toISOString().slice(0, 10) !== parts.slice(1, 4).join("-")) {
    throw new InputError(label + " must be an ISO date and time with an explicit timezone, or null");
  }
  return time;
}

function readBudget(value, label, ownDataOnly = false) {
  if (value == null) return null;
  const fields = ["amount", "currency"];
  if (!ownDataOnly) requireObject(value, fields, label);
  const { amount, currency } = ownDataOnly ? readOwnDataObject(value, fields, label) : value;
  if (!Number.isFinite(amount) || amount < 0 || typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    throw new InputError(label + " requires a nonnegative amount and a three-letter uppercase currency");
  }
  return { amount, currency };
}

function readSalazarEvidence(value, label) {
  const evidence = readOwnDataObject(value ?? {}, Object.keys(evidenceChoices), label);
  return Object.fromEntries(Object.entries(evidenceChoices).map(([field, choices]) => [
    field, readStatus(evidence[field], [...choices, "unknown", "conflicting"], label + "." + field)
  ]));
}

function readInvitation(value, index, salazarPolicyV2) {
  const label = "Invitation " + (index + 1);
  const fields = ["projectId", "title", "deadline", "budget", "description", "scriptAvailability",
    "scriptText", "attachmentRequirements", "invitationStatus", "proposalStatus", "rightsStatus"];
  if (salazarPolicyV2) {
    value = readOwnDataObject(value, [...fields, "salazarEvidence"], label);
  } else {
    requireObject(value, fields, label);
  }
  const projectId = optionalText(value.projectId, label + " projectId");
  const title = optionalText(value.title, label + " title");
  if (!projectId || !/^[a-z0-9]+$/i.test(projectId) || !title) {
    throw new InputError(label + " requires an alphanumeric Voice123 project ID and title");
  }
  return {
    projectId: projectId.toUpperCase(), title,
    deadline: readDeadline(value.deadline, label + " deadline"),
    budget: readBudget(value.budget, label + " budget", salazarPolicyV2),
    description: optionalText(value.description, label + " description"),
    scriptText: optionalText(value.scriptText, label + " scriptText"),
    scriptAvailability: readStatus(value.scriptAvailability, scriptStatuses, label + " scriptAvailability"),
    attachmentRequirements: readStatus(value.attachmentRequirements, attachmentStatuses, label + " attachmentRequirements"),
    invitationStatus: readStatus(value.invitationStatus, invitationStatuses, label + " invitationStatus"),
    proposalStatus: readStatus(value.proposalStatus, proposalStatuses, label + " proposalStatus"),
    rightsStatus: readStatus(value.rightsStatus, rightsStatuses, label + " rightsStatus"),
    ...(salazarPolicyV2 ? { salazarEvidence: readSalazarEvidence(value.salazarEvidence, label + " salazarEvidence") } : {})
  };
}

function readPreferences(value) {
  requireObject(value, ["preferredTerms", "avoidTerms", "budgetTargets"], "Preferences");
  const terms = key => {
    const entries = value[key] ?? [];
    if (!Array.isArray(entries)) throw new InputError("Preferences " + key + " must be an array");
    return [...new Set(entries.map(entry => {
      const term = optionalText(entry, "Preferences " + key + " entry");
      if (!term) throw new InputError("Preferences terms must be nonempty text");
      return term.toLowerCase();
    }))];
  };
  const preferredTerms = terms("preferredTerms");
  const avoidTerms = terms("avoidTerms");
  if (preferredTerms.some(term => avoidTerms.includes(term))) {
    throw new InputError("A term cannot appear in both preference lists");
  }
  const targets = value.budgetTargets ?? {};
  requireObject(targets, null, "Preferences budgetTargets");
  const budgetTargets = new Map(Object.entries(targets).map(([currency, amount]) => {
    const budget = readBudget({ currency, amount }, "Preferences budgetTargets entry");
    return [budget.currency, budget.amount];
  }));
  return { preferredTerms, avoidTerms, budgetTargets };
}

function classify(project, now, policy) {
  const ineligible = [];
  const review = [];
  if (["closed", "withdrawn", "declined"].includes(project.invitationStatus)) {
    ineligible.push("Operator recorded an inactive invitation");
  } else if (project.invitationStatus !== "new") {
    review.push(auditionReadiness({}, project.invitationStatus === "revision_requested" ? "Revision requested" : "Unknown").reason);
  }
  if (project.proposalStatus === "closed") ineligible.push("Project is closed to proposals");
  if (project.proposalStatus === "unknown") review.push("Proposal eligibility is not confirmed");
  if (project.deadline === null) review.push("Deadline is unconfirmed");
  else if (project.deadline <= now) ineligible.push("Deadline has passed");
  if (!project.description) review.push("Project description is missing");
  if (project.attachmentRequirements === "required") review.push("Required attachments need manual review");
  if (project.attachmentRequirements === "unknown") review.push("Attachment requirements are unconfirmed");
  if (project.scriptAvailability === "missing") review.push("Audition script is missing");
  else if (project.scriptAvailability === "unknown") review.push("Audition script availability is unconfirmed");
  else if (project.scriptText && auditionMaterialNeedsReview(project.scriptText)) {
    review.push("Supplied audition material may be incomplete");
  } else if (project.scriptAvailability === "available") {
    review.push("Audition script is listed as available but its usability is unconfirmed");
  }
  if (project.rightsStatus === "review_required") review.push("Voice rights or usage terms need manual review");
  if (project.rightsStatus === "unknown") review.push("Voice rights and usage terms are unconfirmed");

  const disqualifications = [...ineligible, ...(policy?.ineligible ?? [])];
  const reviewReasons = [...review, ...(policy?.review ?? [])];
  const warnings = policy?.warnings ?? [];
  if (disqualifications.length) return { classification: "ineligible", reasons: [...disqualifications, ...reviewReasons, ...warnings] };
  if (reviewReasons.length) return { classification: "needs_review", reasons: [...reviewReasons, ...warnings] };
  return { classification: "eligible", reasons: ["Supplied evidence supports an open invitation with usable audition material", ...warnings] };
}

function scoreFit(project, preferences, policy) {
  const text = (project.title + " " + (project.description ?? "")).toLowerCase();
  const preferredMatches = policy?.preferredMatches ?? preferences.preferredTerms.filter(term => text.includes(term));
  const avoidMatches = policy?.avoidMatches ?? preferences.avoidTerms.filter(term => text.includes(term));
  const target = project.budget && preferences.budgetTargets.get(project.budget.currency);
  let budgetFit = "no_target_for_currency";
  if (!project.budget) budgetFit = "budget_unreported";
  else if (target !== undefined) budgetFit = project.budget.amount >= target ? "meets_target" : "below_target";
  const budgetPoints = policy?.compensationConflict ? 0 : { meets_target: 2, below_target: -2 }[budgetFit] ?? 0;
  return {
    score: 2 * (preferredMatches.length - avoidMatches.length) + budgetPoints,
    preferredMatches, avoidMatches, budgetFit
  };
}

function requireSinglePolicy({ salazarPolicyV1, salazarPolicyV2 }) {
  if (salazarPolicyV1 && salazarPolicyV2) {
    throw new InputError("Salazar Media Policy v1 and v2 are mutually exclusive");
  }
}

function evaluateOpportunities(invites, settings = {}, now = Date.now(), options = {}) {
  requireSinglePolicy(options);
  const { salazarPolicyV1 = false, salazarPolicyV2 = false } = options;
  if (!Array.isArray(invites)) throw new InputError("Invitations must be a JSON array");
  const preferences = readPreferences(settings);
  const seen = new Set();
  const projects = invites.map((entry, index) => {
    const project = readInvitation(entry, index, salazarPolicyV2);
    if (seen.has(project.projectId)) throw new InputError("Duplicate Voice123 project ID in intake");
    seen.add(project.projectId);
    return project;
  });
  const assessPolicy = salazarPolicyV2 ? assessSalazarPolicyV2 : salazarPolicyV1 ? assessSalazarPolicy : null;
  const ranked = projects.map(project => {
    const policy = assessPolicy?.(project, preferences, now);
    return { project, result: classify(project, now, policy), fit: scoreFit(project, preferences, policy) };
  });
  ranked.sort((a, b) =>
    classifications.indexOf(a.result.classification) - classifications.indexOf(b.result.classification) ||
    b.fit.score - a.fit.score ||
    (a.project.deadline ?? Infinity) - (b.project.deadline ?? Infinity) ||
    a.project.projectId.localeCompare(b.project.projectId, "en"));
  return {
    evaluatedAt: new Date(now).toISOString(),
    preferencesConfigured: preferences.preferredTerms.length > 0 || preferences.avoidTerms.length > 0 || preferences.budgetTargets.size > 0,
    opportunities: ranked.map(({ project, result, fit }, index) => ({
      rank: index + 1, projectId: project.projectId, title: project.title,
      deadline: project.deadline === null ? null : new Date(project.deadline).toISOString(),
      budget: project.budget, ...result, fit
    }))
  };
}

async function readLocalJson(filename, label) {
  try {
    const info = await fs.stat(filename);
    if (!info.isFile()) throw new InputError(label + " must be a local regular file");
    return JSON.parse(await fs.readFile(filename, "utf8"));
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(label + " could not be read as local JSON");
  }
}

if (require.main === module) {
  (async () => {
    const usage = "Usage: npm run evaluate -- [--salazar-policy-v1 | --salazar-policy-v2] <invitations.json> [preferences.json]";
    let args;
    try {
      args = parseArgs({
        options: { "salazar-policy-v1": { type: "boolean" }, "salazar-policy-v2": { type: "boolean" } },
        allowPositionals: true
      });
    } catch {
      throw new InputError(usage);
    }
    const [invitesPath, preferencesPath, ...extra] = args.positionals;
    const options = {
      salazarPolicyV1: args.values["salazar-policy-v1"],
      salazarPolicyV2: args.values["salazar-policy-v2"]
    };
    requireSinglePolicy(options);
    if (!invitesPath || extra.length || ((options.salazarPolicyV1 || options.salazarPolicyV2) && !preferencesPath)) {
      throw new InputError(usage);
    }
    const invites = await readLocalJson(invitesPath, "Invitations");
    const settings = preferencesPath ? await readLocalJson(preferencesPath, "Preferences") : {};
    console.log(JSON.stringify(evaluateOpportunities(invites, settings, Date.now(), options), null, 2));
  })().catch(error => {
    console.error(error instanceof InputError ? error.message : "Offline evaluation failed");
    process.exitCode = 1;
  });
}

module.exports = { evaluateOpportunities };
