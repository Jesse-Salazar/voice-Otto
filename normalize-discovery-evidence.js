"use strict";

const channels = ["voice123", "external"];
const statuses = {
  scriptAvailability: ["verified_usable", "available", "missing", "unknown"],
  attachmentRequirements: ["none", "required", "unknown"],
  invitationStatus: ["new", "revision_requested", "closed", "withdrawn", "declined", "unknown"],
  proposalStatus: ["open", "closed", "unknown"],
  rightsStatus: ["reviewed_no_concerns", "review_required", "unknown"],
  scriptLanguage: ["english", "non_english", "mixed", "unknown"],
  paymentChannel: [...channels, "unknown"],
  paymentSecurity: ["secured", "unsecured", "unknown"],
  paymentTerms: ["platform_standard", "nonstandard", "unknown"],
  auditionChannel: [...channels, "unknown"],
  communicationChannel: [...channels, "unknown"],
  transactionChannel: [...channels, "unknown"]
};
const coreFields = ["title", "deadline", "budget", "description", "scriptText", "scriptAvailability",
  "attachmentRequirements", "invitationStatus", "proposalStatus", "rightsStatus"];
const evidenceFields = ["scriptLanguage", "paymentChannel", "paymentSecurity", "paymentTerms",
  "auditionChannel", "communicationChannel", "transactionChannel"];
const fields = [...coreFields, ...evidenceFields];
const channelFields = new Set(["paymentChannel", "auditionChannel", "communicationChannel", "transactionChannel"]);
const historySources = ["Local history", "Google Sheets"];
const applicability = ["required", "optional", "unknown"];
const routeAvailability = ["required", "alternative", "unknown"];
const tokenPattern = /^[A-Za-z0-9_-]{1,64}$/;
const datePattern = /^(\d{4}-\d\d-\d\d)T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const placeholder = /^(?:no description|n\s*\/?\s*a|none|not (?:provided|applicable|required)|[-—]+)[.!]?$/i;

function diagnostic(code, severity, path, projectId = null, field = null, refs = []) {
  return { code, severity, projectId, field, path, refs };
}

function fail(path, code = "INVALID_INPUT", projectId = null, field = null) {
  const error = new Error(code);
  error.name = "ObservationInputError";
  error.diagnostic = diagnostic(code, "error", path, projectId, field);
  throw error;
}

function pointer(path, key) {
  return path + "/" + key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function record(value, path, required, optional = []) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) fail(path);
  const result = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !required.includes(key) && !optional.includes(key)) fail(path);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail(pointer(path, key));
    if (descriptor.value === undefined) fail(pointer(path, key));
    result[key] = descriptor.value;
  }
  for (const key of required) {
    if (!Object.hasOwn(result, key)) fail(pointer(path, key));
  }
  return result;
}

function array(value, path) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(path);
  const length = Object.getOwnPropertyDescriptor(value, "length").value;
  if (Reflect.ownKeys(value).length !== length + 1) fail(path);
  const result = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) fail(path + "/" + index);
    if (descriptor.value === undefined) fail(path + "/" + index);
    result.push(descriptor.value);
  }
  return result;
}

function choice(value, values, path) {
  if (!values.includes(value)) fail(path);
  return value;
}

function text(value, limit, path) {
  if (typeof value !== "string" || value.length > limit || !value.trim() ||
      /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.[\p{L}\p{N}])/iu.test(value)) fail(path);
  return value;
}

function token(value, path) {
  if (typeof value !== "string" || !tokenPattern.test(value)) fail(path);
  return value;
}

function count(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) fail(path);
  return value === 0 ? 0 : value;
}

function timestamp(value, path) {
  const match = typeof value === "string" && datePattern.exec(value);
  const time = match ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) fail(path);
  const day = new Date(match[1] + "T00:00:00Z").toISOString();
  const utc = new Date(time).toISOString();
  if (day.slice(0, 10) !== match[1] || !/^\d{4}-/.test(utc)) fail(path);
  return utc;
}

function identity(value, path) {
  if (typeof value !== "string" || !/^[a-z0-9]+$/i.test(value.trim())) {
    fail(path, "INVALID_PROJECT_ID", null, "projectId");
  }
  return value.trim().toUpperCase();
}

function projectUrl(value, projectId, path) {
  const match = typeof value === "string" && value.length <= 2048 &&
    /^https:\/\/voice123\.com\/projects\/([a-z0-9]+)\/[^/%?#\\\s\u0000-\u001f\u007f]+\/specs\/?$/i.exec(value);
  if (!match) fail(path);
  const url = new URL(value);
  if (url.origin !== "https://voice123.com" || url.href !== value) fail(path);
  if (match[1].toUpperCase() !== projectId) fail(path, "PROJECT_ID_MISMATCH", projectId, "projectId");
  return value;
}

function links(value, path, context = {}) {
  const result = array(value, path).map((entry, index) => token(entry, path + "/" + index));
  if (!result.length || new Set(result).size !== result.length) {
    fail(path, "INVALID_REFERENCE", context.projectId, context.field);
  }
  return result;
}

function requirement(value, path) {
  const data = record(value, path, ["id", "applicability"]);
  return { id: token(data.id, path + "/id"), applicability: choice(data.applicability, applicability, path + "/applicability") };
}

function typedValue(field, value, path) {
  if (Object.hasOwn(statuses, field)) return choice(value, statuses[field], path);
  if (field === "title") return text(value, 300, path);
  if (field === "description") return text(value, 20000, path);
  if (field === "deadline") {
    timestamp(value, path);
    return value;
  }
  if (field === "budget") {
    const data = record(value, path, ["amount", "currency"]);
    if (!Number.isFinite(data.amount) || data.amount < 0) fail(path + "/amount");
    if (typeof data.currency !== "string" || !/^[A-Z]{3}$/.test(data.currency)) fail(path + "/currency");
    return { amount: data.amount === 0 ? 0 : data.amount, currency: data.currency };
  }
  if (field === "scriptText") {
    const data = record(value, path, ["kind", "text"]);
    return {
      kind: choice(data.kind, ["copy", "instruction", "pronunciation", "reference", "placeholder"], path + "/kind"),
      text: text(data.text, 20000, path)
    };
  }
  if (field === "route") {
    const data = record(value, path, ["channel", "availability"]);
    return {
      channel: choice(data.channel, [...channels, "unknown"], path + "/channel"),
      availability: choice(data.availability, routeAvailability, path + "/availability")
    };
  }
  const data = record(value, path, ["kind"]);
  return { kind: choice(data.kind, ["external_reference"], path + "/kind") };
}

function readObservation(value, path, projectId) {
  const data = record(value, path, ["id", "field", "scope", "method", "section", "value"],
    ["observedAt", "excerpt", "observer", "requirement", "requiredIds"]);
  const id = token(data.id, path + "/id");
  const field = choice(data.field, [...fields, "route", "reference"], path + "/field");
  const scope = token(data.scope, path + "/scope");
  const method = choice(data.method, ["structured", "operator_observed", "excerpt"], path + "/method");
  const result = { id, field, scope, method, section: text(data.section, 120, path + "/section"), value: null };
  if (method === "operator_observed") result.observer = token(data.observer, path + "/observer");
  else if (data.observer !== undefined) fail(path + "/observer");
  if (data.observedAt !== undefined) {
    timestamp(data.observedAt, path + "/observedAt");
    result.observedAt = data.observedAt;
  }
  if (data.excerpt !== undefined || method === "excerpt") result.excerpt = text(data.excerpt, 500, path + "/excerpt");

  if (data.requirement !== undefined) {
    if (!channelFields.has(field) || data.requiredIds !== undefined) fail(path + "/requirement");
    result.requirement = requirement(data.requirement, path + "/requirement");
  }
  if (data.requiredIds !== undefined) {
    if (!channelFields.has(field) || scope === "unknown" || method === "excerpt" || data.value !== null) {
      fail(path + "/requiredIds");
    }
    result.requiredIds = links(data.requiredIds, path + "/requiredIds", { projectId, field });
  } else if (method === "excerpt") {
    if (data.value !== null) fail(path + "/value");
  } else if (data.value !== null || !["title", "deadline", "budget", "description", "scriptText"].includes(field)) {
    result.value = typedValue(field, data.value, path + "/value");
  }
  return result;
}

function readDetermination(value, path, projectId) {
  const data = record(value, path, ["id", "field", "scope", "value", "observationIds", "reviewer", "rationale"],
    ["reviewedAt", "requirement"]);
  const field = choice(data.field, fields, path + "/field");
  const result = {
    id: token(data.id, path + "/id"), field, scope: token(data.scope, path + "/scope"),
    value: typedValue(field, data.value, path + "/value"),
    observationIds: links(data.observationIds, path + "/observationIds", { projectId, field }),
    reviewer: token(data.reviewer, path + "/reviewer"), rationale: text(data.rationale, 500, path + "/rationale")
  };
  if (data.reviewedAt !== undefined) {
    timestamp(data.reviewedAt, path + "/reviewedAt");
    result.reviewedAt = data.reviewedAt;
  }
  if (data.requirement !== undefined) {
    if (!channelFields.has(field)) fail(path + "/requirement");
    result.requirement = requirement(data.requirement, path + "/requirement");
  }
  return result;
}

function readRoute(value, path, projectId) {
  const data = record(value, path, ["id", "channel", "availability", "observationIds"]);
  const id = token(data.id, path + "/id");
  if (id === "project" || id === "unknown") fail(path + "/id");
  return {
    id, channel: choice(data.channel, [...channels, "unknown"], path + "/channel"),
    availability: choice(data.availability, routeAvailability, path + "/availability"),
    observationIds: links(data.observationIds, path + "/observationIds", { projectId, field: "route" })
  };
}

function list(value, path, read) {
  return value === undefined ? [] : array(value, path).map((item, index) => read(item, path + "/" + index));
}

function history(value, path) {
  const result = list(value, path, (item, itemPath) => choice(item, historySources, itemPath));
  if (new Set(result).size !== result.length) fail(path);
  return result;
}

function readProject(value, path) {
  const data = record(value, path, ["projectId", "readStatus"],
    ["url", "titleHint", "duplicateSources", "routes", "observations", "determinations"]);
  const projectId = identity(data.projectId, path + "/projectId");
  const readStatus = choice(data.readStatus, ["observed", "failed"], path + "/readStatus");
  const project = {
    projectId, readStatus, url: data.url === undefined ? null : projectUrl(data.url, projectId, path + "/url"),
    titleHint: data.titleHint === undefined ? null : text(data.titleHint, 300, path + "/titleHint"),
    duplicateSources: history(data.duplicateSources, path + "/duplicateSources"),
    routes: list(data.routes, path + "/routes", (item, at) => readRoute(item, at, projectId)),
    observations: list(data.observations, path + "/observations", (item, at) => readObservation(item, at, projectId)),
    determinations: list(data.determinations, path + "/determinations", (item, at) => readDetermination(item, at, projectId)),
    preview: null
  };
  if (readStatus === "failed") {
    for (const key of ["routes", "observations", "determinations"]) {
      if (project[key].length) fail(path + "/" + key);
    }
  }
  return project;
}

function indexRecords(items, path, projectId) {
  const indexed = new Map();
  items.forEach((item, index) => {
    if (indexed.has(item.id)) fail(path + "/" + index + "/id", "INVALID_INPUT", projectId);
    indexed.set(item.id, item);
  });
  return indexed;
}

function verifyReferences(project, path) {
  const { projectId, routes, observations, determinations } = project;
  const routeById = indexRecords(routes, path + "/routes", projectId);
  const observationById = indexRecords(observations, path + "/observations", projectId);
  indexRecords(determinations, path + "/determinations", projectId);
  observations.forEach((item, index) => {
    const at = path + "/observations/" + index;
    const routeScoped = routeById.has(item.scope);
    if (!routeScoped && (item.field === "route" || !["project", "unknown"].includes(item.scope))) {
      fail(at + "/scope", "INVALID_REFERENCE", projectId, item.field);
    }
    if (item.requiredIds) {
      item.requiredIds.forEach((id, refIndex) => {
        const valid = observations.some(step => step.field === item.field && step.requirement?.id === id &&
          (step.scope === "project" || step.scope === item.scope));
        if (!valid) fail(at + "/requiredIds/" + refIndex, "INVALID_REFERENCE", projectId, item.field);
      });
    }
  });
  routes.forEach((route, index) => {
    const at = path + "/routes/" + index + "/observationIds";
    const typed = observations.filter(item => item.field === "route" && item.scope === route.id && item.value !== null);
    const typedIds = new Set(typed.map(item => item.id));
    route.observationIds.forEach((id, refIndex) => {
      if (!typedIds.has(id)) fail(at + "/" + refIndex, "INVALID_REFERENCE", projectId, "route");
    });
    if (route.observationIds.length !== typed.length ||
        !typed.some(item => item.value.channel === route.channel && item.value.availability === route.availability)) {
      fail(at, "INVALID_REFERENCE", projectId, "route");
    }
  });
  determinations.forEach((item, index) => {
    const at = path + "/determinations/" + index;
    if (item.scope !== "project" && !routeById.has(item.scope)) {
      fail(at + "/scope", "INVALID_REFERENCE", projectId, item.field);
    }
    item.observationIds.forEach((id, refIndex) => {
      const observation = observationById.get(id);
      if (!observation || observation.scope !== item.scope) {
        fail(at + "/observationIds/" + refIndex, "INVALID_REFERENCE", projectId, item.field);
      }
    });
  });
  return observationById;
}

function knownValues(values) {
  return [...new Set(values.filter(value => value !== null && value !== "unknown"))];
}

function selectRoute(routes, byId) {
  if (!routes.length) return { routeId: null, routeSelectionReason: "NO_ROUTES" };
  const declarations = routes.map(route => {
    const claims = route.observationIds.map(id => byId.get(id).value);
    return {
      route,
      contradictory: knownValues(claims.map(item => item.channel)).length > 1 ||
        knownValues(claims.map(item => item.availability)).length > 1
    };
  });
  const required = routes.filter(route => route.availability === "required");
  const platform = routes.filter(route => route.channel === "voice123" && route.availability === "alternative");
  if (declarations.some(item => item.contradictory)) {
    return { routeId: null, routeSelectionReason: "CONTRADICTORY_ROUTE_DECLARATIONS" };
  }
  if (routes.some(route => route.channel === "unknown" || route.availability === "unknown")) {
    return { routeId: null, routeSelectionReason: "UNKNOWN_ROUTE_APPLICABILITY" };
  }
  if (required.length > 1) return { routeId: null, routeSelectionReason: "MULTIPLE_REQUIRED_ROUTES" };
  if (required.length === 1) return { routeId: required[0].id, routeSelectionReason: "VERIFIED_REQUIRED_ROUTE" };
  if (platform.length > 1) return { routeId: null, routeSelectionReason: "MULTIPLE_VOICE123_ALTERNATIVES" };
  if (platform.length === 1) return { routeId: platform[0].id, routeSelectionReason: "UNIQUE_VOICE123_ALTERNATIVE" };
  return { routeId: null, routeSelectionReason: "NO_SUPPORTED_VOICE123_ALTERNATIVE" };
}

function normalizedValue(field, value) {
  if (field === "deadline") return new Date(Date.parse(value)).toISOString();
  if (field === "title" || field === "description") return value.trim();
  if (field === "scriptText") return { kind: value.kind, text: value.text.trim() };
  return value;
}

function valueKey(field, value) {
  const normalized = normalizedValue(field, value);
  if (field === "budget") return normalized.currency + ":" + normalized.amount;
  if (field === "scriptText") return normalized.kind + ":" + normalized.text;
  return normalized;
}

function sameRequirement(left, right) {
  return left?.id === right?.id && left?.applicability === right?.applicability;
}

function corroboration(item, byId) {
  const supporting = item.observationIds.map(id => byId.get(id));
  const matching = supporting.filter(observation => observation.field === item.field && observation.value !== null &&
    !observation.requiredIds && sameRequirement(observation.requirement, item.requirement) &&
    valueKey(item.field, observation.value) === valueKey(item.field, item.value));
  if (item.field === "rightsStatus" && item.value === "reviewed_no_concerns") {
    return matching.some(observation => observation.method === "operator_observed");
  }
  if (item.field === "scriptAvailability" && item.value === "verified_usable") {
    return matching.length > 0 && supporting.some(observation => observation.field === "scriptText" &&
      observation.value?.kind === "copy" && !placeholder.test(observation.value.text.trim()));
  }
  return matching.length > 0;
}

function resolveChannel(field, observations, selection, report) {
  const whole = observations.filter(item => !item.requirement && !item.requiredIds);
  const granular = observations.filter(item => item.requirement || item.requiredIds);
  const wholeExternal = whole.filter(item => item.value === "external");
  const wholePlatform = whole.filter(item => item.value === "voice123");
  const grouped = new Map();
  for (const item of granular) {
    if (!item.requirement) continue;
    const id = item.requirement.id;
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(item);
  }
  const steps = Array.from(grouped, ([id, claims]) => {
    const modes = knownValues(claims.map(item => item.requirement.applicability));
    const values = knownValues(claims.map(item => item.value));
    return {
      id, claims, required: modes.length === 1 && modes[0] === "required",
      optional: modes.length === 1 && modes[0] === "optional",
      applicabilityConflict: modes.length > 1, channelConflict: values.length > 1,
      channel: values.length === 1 ? values[0] : null
    };
  });
  const required = steps.filter(step => step.required);
  const unknownApplicability = steps.filter(step => !step.required && !step.optional);
  const unsettled = [...unknownApplicability, ...required.filter(step => step.channel === null)];
  const externalSteps = required.filter(step => step.channel === "external");
  const coverageScope = selection.routeId ?? (selection.routeSelectionReason === "NO_ROUTES" ? "project" : null);
  const coverage = granular.filter(item => item.requiredIds && item.scope === coverageScope);
  const covered = new Set(coverage[0]?.requiredIds ?? []);
  const omitted = required.filter(step => coverage.some(item => !item.requiredIds.includes(step.id)));
  const wronglyListed = steps.filter(step => step.optional && coverage.some(item => item.requiredIds.includes(step.id)));
  const disputedCoverage = coverage.some(item => item.requiredIds.length !== covered.size ||
    item.requiredIds.some(id => !covered.has(id)));
  const coverageConflict = disputedCoverage || omitted.length > 0 || wronglyListed.length > 0;
  const complete = coverage.length > 0 && !coverageConflict && unsettled.length === 0 &&
    covered.size === required.length;
  const completePlatform = complete && required.every(step => step.channel === "voice123");
  const wholeConflict = wholeExternal.length > 0 && wholePlatform.length > 0;
  const granularOpposition = wholeExternal.length > 0 && completePlatform;
  const mandatoryDispute = steps.some(step => step.applicabilityConflict || !step.optional && step.channelConflict);

  let value = "unknown";
  if (externalSteps.length) value = "external";
  else if (wholeExternal.length && (wholeConflict || granularOpposition)) value = "conflicting";
  else if (wholeExternal.length) value = "external";
  else if (mandatoryDispute) value = "conflicting";
  else if (completePlatform || !granular.length && wholePlatform.length) value = "voice123";

  const stepClaims = items => items.flatMap(step => step.claims);
  if (wholeConflict) report("FIELD_CONFLICT", field, [...wholeExternal, ...wholePlatform], false);
  if (granularOpposition) {
    report("FIELD_CONFLICT", field, [...wholeExternal, ...stepClaims(required), ...coverage], true);
  }
  if (wholePlatform.length && externalSteps.length) {
    report("FIELD_CONFLICT", field, [...wholePlatform, ...stepClaims(externalSteps)], true);
  }
  for (const step of steps) {
    if (!step.required && !step.optional) {
      report("REQUIREMENT_APPLICABILITY_UNRESOLVED", field, step.claims, true, "/observations");
    }
    if (step.applicabilityConflict) report("FIELD_CONFLICT", field, step.claims, true);
    if (step.channelConflict) report("FIELD_CONFLICT", field, step.claims, !step.optional || !complete);
  }
  if (coverageConflict) {
    report("FIELD_CONFLICT", field, [...coverage, ...stepClaims([...omitted, ...wronglyListed])], true);
  }
  if (granular.length && !complete && (value !== "external" || unsettled.length || coverage.length)) {
    const refs = [...coverage, ...stepClaims([...unsettled, ...omitted, ...wronglyListed])];
    report("REQUIREMENT_COVERAGE_INCOMPLETE", field, refs.length ? refs : granular, true, "/observations");
  }
  return value;
}

function isKnown(field, value) {
  return value !== null && (!Object.hasOwn(statuses, field) || value !== "unknown");
}

function fieldState(field, value, items, ambiguous = false) {
  if (evidenceFields.includes(field) && value === "conflicting") return "conflicting";
  if (isKnown(field, value)) return "supported";
  if (ambiguous || items.some(item => item.method === "excerpt")) return "ambiguous";
  return items.length ? "unknown" : "missing";
}

function ordinaryField(field, items, determinations, report) {
  const claims = items.filter(item => {
    if (!isKnown(field, item.value)) return false;
    if (field === "description" && placeholder.test(item.value.trim())) return false;
    if (field === "scriptText") return item.value.kind === "copy" && !placeholder.test(item.value.text.trim());
    if ((field === "scriptAvailability" && item.value === "verified_usable") ||
        (field === "rightsStatus" && item.value === "reviewed_no_concerns")) {
      return determinations.some(entry => entry.field === field && entry.value === item.value &&
        entry.observationIds.includes(item.id));
    }
    return true;
  });
  const distinct = new Map(claims.map(item => [valueKey(field, item.value), normalizedValue(field, item.value)]));
  const empty = Object.hasOwn(statuses, field) ? "unknown" : null;
  let value = claims.length ? distinct.values().next().value : empty;
  if (field === "scriptAvailability" && distinct.has("verified_usable") && distinct.has("available")) {
    distinct.delete("available");
    value = "verified_usable";
  }
  if (distinct.size > 1) {
    report("FIELD_CONFLICT", field, claims, field === "title" || field === "description");
    if (field === "rightsStatus" && distinct.has("review_required")) value = "review_required";
    else value = evidenceFields.includes(field) ? "conflicting" : empty;
    return { value, state: "conflicting" };
  }
  const ambiguous = items.some(item => isKnown(field, item.value) && !claims.includes(item));
  return { value, state: fieldState(field, value, items, ambiguous) };
}

function projectResult(project, index, byId) {
  const path = "/projects/" + index;
  const { projectId, readStatus, observations, determinations, routes, preview } = project;
  const selection = readStatus === "failed"
    ? { routeId: null, routeSelectionReason: "PROJECT_READ_FAILED" }
    : selectRoute(routes, byId);
  const companion = { ...project, ...selection, reviewHold: false, fields: {} };
  const diagnostics = [];
  const observationOrder = new Map(observations.map((item, at) => [item.id, at]));
  const determinationOrder = new Map(determinations.map((item, at) => [item.id, at]));
  const positions = preview ? {
    title: "/title", deadline: "/deadline", invitationStatus: "/invitationStatus",
    proposalStatus: "/proposalEligibility", scriptAvailability: "/fieldStatus", rightsStatus: "/rightsFlags"
  } : {};
  const obsRefs = items => {
    const included = new Set(items);
    return observations.filter(item => included.has(item)).map(item => item.id);
  };
  function report(code, field, items, hold, suffix) {
    const refs = obsRefs(items);
    const first = refs.length ? observationOrder.get(refs[0]) : null;
    const at = path + (suffix ?? positions[field] ?? (first === null ? "/observations" : "/observations/" + first));
    diagnostics.push(diagnostic(code, "review", at, projectId, field, refs));
    companion.reviewHold ||= hold;
  }

  if (readStatus === "failed") {
    report("PROJECT_READ_FAILED", null, [], true, preview ? "/status" : "/readStatus");
    return { companion, invitation: null, diagnostics };
  }
  if (routes.length && selection.routeId === null) {
    const ids = new Set(routes.flatMap(route => route.observationIds));
    report("ROUTE_UNRESOLVED", null, observations.filter(item => ids.has(item.id)), true, "/routes");
  }
  const admitted = item => item.scope === "project" || item.scope === selection.routeId;
  const supported = [];
  for (const item of determinations) {
    if (corroboration(item, byId)) {
      supported.push(item);
    } else {
      const refs = obsRefs(item.observationIds.map(id => byId.get(id)));
      const at = path + "/determinations/" + determinationOrder.get(item.id);
      diagnostics.push(diagnostic("DETERMINATION_UNSUPPORTED", "review", at, projectId, item.field, [...refs, item.id]));
      companion.reviewHold = true;
    }
  }

  const resolved = {};
  const applicableDeterminations = supported.filter(admitted);
  for (const field of fields) {
    const items = observations.filter(item => item.field === field && admitted(item));
    const unscoped = observations.filter(item => item.field === field && item.scope === "unknown");
    const decisions = applicableDeterminations.filter(item => item.field === field);
    const contextual = decisions.flatMap(item => item.observationIds.map(id => byId.get(id)));
    const channel = channelFields.has(field);
    if (channel) {
      const value = resolveChannel(field, items, selection, report);
      const ambiguous = items.some(item => item.requirement || item.requiredIds) || unscoped.length > 0;
      resolved[field] = { value, state: fieldState(field, value, items, ambiguous) };
    } else {
      resolved[field] = ordinaryField(field, items, applicableDeterminations, report);
      if (resolved[field].state === "missing" && unscoped.length) resolved[field].state = "ambiguous";
    }
    const current = resolved[field];
    const scopeEvidence = unscoped.filter(item => isKnown(field, item.value) ||
      (channel && item.requirement?.applicability === "required"));
    if (scopeEvidence.length) {
      const hold = scopeEvidence.some(item => {
        if (channel && (current.value === "external" ||
            item.requirement && item.requirement.applicability !== "optional")) return true;
        return current.state === "supported" && valueKey(field, item.value) !== valueKey(field, current.value);
      });
      report("SCOPE_UNCONFIRMED", field, scopeEvidence, hold);
    }
    if (current.state === "ambiguous" && items.some(item => item.method === "excerpt")) {
      report("FIELD_AMBIGUOUS", field, items.filter(item => item.method === "excerpt"), false);
    }
    companion.fields[field] = {
      ...current, observationIds: obsRefs([...items, ...unscoped, ...contextual]),
      determinationIds: decisions.map(item => item.id)
    };
  }
  reconcileCopy(resolved, companion.fields, observations, admitted, report);

  if (resolved.title.value === null) {
    const titleFacts = observations.filter(item => item.field === "title" && admitted(item));
    report("TITLE_UNVERIFIED", "title", titleFacts, true);
    companion.fields.title.value = projectId;
  }
  const description = resolved.description.value;
  const missingCompensation = observations.filter(item => admitted(item) && item.field === "budget" &&
    item.method === "excerpt" && !description?.includes(item.excerpt));
  if (missingCompensation.length) {
    report("COMPENSATION_CONTEXT_UNREPRESENTED", "budget", missingCompensation, true);
  }

  const invitation = { projectId, title: companion.fields.title.value };
  for (const field of coreFields.slice(1)) {
    const value = resolved[field].value;
    invitation[field] = field === "scriptText" ? value?.text ?? null :
      field === "budget" && value !== null ? { ...value } : value;
  }
  const copy = companion.fields.scriptText.value;
  companion.fields.scriptText.value = copy?.text ?? null;
  if (resolved.budget.value !== null) companion.fields.budget.value = { ...resolved.budget.value };
  invitation.salazarEvidence = Object.fromEntries(evidenceFields.map(field => [field, resolved[field].value]));
  diagnostics.sort((left, right) => fields.indexOf(left.field) - fields.indexOf(right.field) ||
    compare(left.code, right.code) || compare(left.path, right.path));
  return { companion, invitation, diagnostics };
}

function compare(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function reconcileCopy(resolved, provenance, observations, admitted, report) {
  const copy = resolved.scriptText;
  const availability = resolved.scriptAvailability;
  const copyObservations = observations.filter(item => admitted(item) && item.field === "scriptText" &&
    item.value?.kind === "copy" && !placeholder.test(item.value.text.trim()));
  const missingObservations = observations.filter(item => admitted(item) && item.field === "scriptAvailability" &&
    item.value === "missing");
  if (copy.state === "conflicting" || copy.value && missingObservations.length) {
    if (copy.value && missingObservations.length && availability.state !== "conflicting") {
      report("FIELD_CONFLICT", "scriptAvailability", [...copyObservations, ...missingObservations], false);
    }
    copy.value = null;
    copy.state = "conflicting";
    availability.value = "unknown";
    availability.state = "conflicting";
  } else if (availability.state !== "conflicting") {
    if (copy.value && availability.value === "unknown") {
      availability.value = "available";
      availability.state = "supported";
    } else if (!copy.value && ["verified_usable", "available"].includes(availability.value)) {
      availability.value = "unknown";
      availability.state = "ambiguous";
    }
  }
  provenance.scriptText.value = copy.value;
  provenance.scriptText.state = copy.state;
  provenance.scriptAvailability.value = availability.value;
  provenance.scriptAvailability.state = availability.state;
  const retained = new Set(provenance.scriptAvailability.observationIds);
  for (const item of copyObservations) retained.add(item.id);
  provenance.scriptAvailability.observationIds = observations.filter(item => retained.has(item.id)).map(item => item.id);
}

function finishBatch(source, coverage, discovered, projects) {
  const sampled = projects.length;
  const failed = projects.filter(project => project.readStatus === "failed").length;
  const observed = sampled - failed;
  const coveragePath = source === "preview" ? "/status" : "/coverage";
  if (discovered !== null && discovered < sampled) fail("/discovered");
  if (coverage === "complete" && (!sampled || failed || discovered !== null && discovered !== sampled) ||
      coverage === "confirmed_empty" && (sampled || discovered !== null && discovered !== 0) ||
      coverage === "failed" && (sampled || discovered !== null)) fail(coveragePath);

  const status = coverage === "unknown" && (failed || discovered !== null && discovered > sampled)
    ? "partial" : coverage;
  const batch = {
    source, status, discovered, sampled, observed, failed,
    evaluationAllowed: status === "confirmed_empty" || observed > 0
  };
  const references = projects.map((project, index) => verifyReferences(project, "/projects/" + index));
  const projectIds = new Set();
  projects.forEach(({ projectId }, index) => {
    if (projectIds.has(projectId)) {
      const idKey = source === "preview" ? "/id" : "/projectId";
      fail("/projects/" + index + idKey, "DUPLICATE_PROJECT_ID", projectId, "projectId");
    }
    projectIds.add(projectId);
  });
  const diagnostics = [];
  const batchCode = {
    partial: "BATCH_PARTIAL", unknown: "BATCH_COVERAGE_UNKNOWN", failed: "DISCOVERY_FAILED"
  }[status];
  if (batchCode) diagnostics.push(diagnostic(batchCode, "review", coveragePath));

  const companions = [];
  const invitations = [];
  projects.forEach((project, index) => {
    const result = projectResult(project, index, references[index]);
    companions.push(result.companion);
    if (result.invitation) invitations.push(result.invitation);
    for (const item of result.diagnostics) diagnostics.push(item);
  });
  return { invitations, batch, projects: companions, diagnostics };
}

function normalizeDiscoveryEvidence(batch) {
  const data = record(batch, "", ["schemaVersion", "source", "coverage", "projects"], ["discovered"]);
  if (!Number.isInteger(data.schemaVersion)) fail("/schemaVersion");
  if (data.schemaVersion !== 1) fail("/schemaVersion", "UNSUPPORTED_SCHEMA_VERSION");
  const source = choice(data.source, ["synthetic", "operator", "captured"], "/source");
  const coverage = choice(data.coverage, ["complete", "partial", "unknown", "confirmed_empty", "failed"], "/coverage");
  const discovered = data.discovered === undefined ? null : count(data.discovered, "/discovered");
  const projects = list(data.projects, "/projects", readProject);
  return finishBatch(source, coverage, discovered, projects);
}

const previewFailures = ["configuration_error", "identity_unverified", "identity_mismatch", "dashboard_incomplete",
  "sheets_unverified", "history_unverified", "browser_isolation_unavailable", "discovery_failed"];
const previewFlags = ["Permanent usage", "Voice-data sublicensing", "TTS or synthetic-voice authorization"];

function readPreviewProject(value, path) {
  const base = ["id", "title", "url", "deadline", "duplicateSources", "status"];
  const success = ["invitationStatus", "reviewReason", "proposalEligibility",
    "fieldStatus", "fieldCharacters", "attachments", "rightsFlags"];
  const header = record(value, path, base, success);
  const status = choice(header.status, ["Needs Review", "project_read_failed"], path + "/status");
  const failed = status === "project_read_failed";
  const data = record(value, path, failed ? base : [...base, ...success]);
  const projectId = identity(data.id, path + "/id");
  const title = text(data.title, 300, path + "/title");
  const deadline = text(data.deadline, 500, path + "/deadline");
  const url = projectUrl(data.url, projectId, path + "/url");
  const fallback = title.trim().toUpperCase() === projectId;
  const duplicateSources = history(data.duplicateSources, path + "/duplicateSources");
  const preview = {
    status, reviewReason: null, fieldStatus: null, fieldCharacters: null,
    attachments: [], rightsFlags: [], proposalEligibility: null, invitationStatus: null, deadline
  };
  const project = {
    projectId, readStatus: failed ? "failed" : "observed", url,
    titleHint: failed || fallback ? title : null, duplicateSources,
    routes: [], observations: [], determinations: [], preview
  };
  if (failed) return project;

  preview.reviewReason = data.reviewReason === null ? null : text(data.reviewReason, 500, path + "/reviewReason");
  preview.proposalEligibility = choice(data.proposalEligibility, ["Yes", "No", "Unknown"], path + "/proposalEligibility");
  preview.invitationStatus = choice(data.invitationStatus, ["New invitation", "Revision requested", "Unknown"], path + "/invitationStatus");
  preview.fieldStatus = choice(data.fieldStatus, ["Valid", "Missing", "Needs Review"], path + "/fieldStatus");
  preview.fieldCharacters = count(data.fieldCharacters, path + "/fieldCharacters");
  preview.rightsFlags = list(data.rightsFlags, path + "/rightsFlags", (flag, at) => choice(flag, previewFlags, at));
  preview.attachments = list(data.attachments, path + "/attachments", (value, at) => {
    const item = record(value, at, ["types", "element"]);
    return {
      types: list(item.types, at + "/types", token),
      element: token(item.element, at + "/element")
    };
  });

  function observe(id, field, section, value) {
    project.observations.push({ id: "preview-" + id, field, scope: "project", method: "structured", section, value });
  }
  if (!fallback) observe("title", "title", "Dashboard display title", title);
  observe("deadline", "deadline", "Dashboard deadline", null);
  if (deadline !== "No deadline found") {
    const item = project.observations[project.observations.length - 1];
    item.method = "excerpt";
    item.excerpt = deadline;
  }
  observe("invitation", "invitationStatus", "Preview invitation indicator",
    preview.invitationStatus === "Revision requested" ? "revision_requested" : "unknown");
  observe("proposal", "proposalStatus", "Preview proposal indicator",
    preview.proposalEligibility === "No" ? "closed" : "unknown");
  observe("script", "scriptAvailability", "Preview custom audition field indicator", "unknown");
  observe("rights", "rightsStatus", "Preview rights-risk flags", preview.rightsFlags.length ? "review_required" : "unknown");
  return project;
}

function normalizeDiscoveryPreview(preview) {
  const header = record(preview, "", ["status"], ["reason", "discovered", "sampled", "projects"]);
  const status = choice(header.status, ["projects_discovered", "project_read_failed", "empty_inbox", ...previewFailures], "/status");
  if (previewFailures.includes(status)) {
    const data = record(preview, "", ["status"], ["reason"]);
    if (data.reason !== undefined) text(data.reason, 500, "/reason");
    return finishBatch("preview", "failed", null, []);
  }
  if (status === "empty_inbox") {
    const data = record(preview, "", ["status", "discovered", "projects"]);
    if (count(data.discovered, "/discovered") !== 0) fail("/discovered");
    if (array(data.projects, "/projects").length) fail("/projects");
    return finishBatch("preview", "confirmed_empty", 0, []);
  }
  const data = record(preview, "", ["status", "discovered", "sampled", "projects"]);
  const sampled = count(data.sampled, "/sampled");
  const discovered = count(data.discovered, "/discovered");
  const projects = list(data.projects, "/projects", readPreviewProject);
  if (!sampled || sampled > 3 || sampled !== projects.length || sampled > discovered) fail("/sampled");
  const failed = projects.some(project => project.readStatus === "failed");
  if (failed !== (status === "project_read_failed")) fail("/status");
  return finishBatch("preview", "partial", discovered, projects);
}

module.exports = { normalizeDiscoveryEvidence, normalizeDiscoveryPreview };
