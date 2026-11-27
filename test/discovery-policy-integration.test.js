"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { normalizeDiscoveryEvidence, normalizeDiscoveryPreview } = require("../normalize-discovery-evidence");
const { evaluateOpportunities } = require("../evaluate-opportunities");
const fixture = require("./fixtures/discovery-policy-observations.json");

const now = Date.parse(fixture.evaluatedAt);
const { preferences } = fixture;
const policy = { salazarPolicyV2: true };
const channelLabels = {
  paymentChannel: ["Payment channel", "Payment must occur outside Voice123"],
  auditionChannel: ["Audition channel", "Audition submission must occur outside Voice123"],
  communicationChannel: ["Communication channel", "Project communications must occur outside Voice123"],
  transactionChannel: ["Transaction channel", "Business transactions must occur outside Voice123"]
};
const channelFields = Object.keys(channelLabels);
const evidenceFields = ["scriptLanguage", ...channelFields, "paymentSecurity", "paymentTerms"];
const clone = value => structuredClone(value);
const supported = () => clone(fixture.supported.input.projects[0]);
const batch = (projects, coverage = "complete", rest = {}) => ({ schemaVersion: 1, source: "synthetic", coverage, projects, ...rest });
const normalize = project => normalizeDiscoveryEvidence(batch([project]));
const evaluate = result => {
  assert.equal(result.batch.evaluationAllowed, true);
  return evaluateOpportunities(result.invitations, preferences, now, policy).opportunities;
};
const observation = (id, field, value, extra = {}) => ({ id, field, value, scope: "project", method: "structured", section: id, ...extra });
const excerpt = (id, field, value) => observation(id, field, null, { method: "excerpt", excerpt: value });
const replace = (project, field, ...claims) => {
  project.observations = project.observations.filter(item => item.field !== field).concat(claims);
};
const removeCopyReview = project => {
  project.determinations = project.determinations.filter(item => item.field !== "scriptAvailability");
  replace(project, "scriptAvailability");
};
const codes = result => result.diagnostics.map(item => item.code);
const first = result => result.projects[0];
const fieldOf = (result, field) => first(result).fields[field];
const row = result => evaluate(result)[0];
const decision = (id, field, value, observationIds, extra = {}) => ({
  id, field, value, observationIds, scope: "project", reviewer: "fixture-reviewer",
  rationale: "Review of the explicitly cited synthetic observation.", ...extra
});

function expectFatal(action, code = "INVALID_INPUT", details = {}) {
  assert.throws(action, error => {
    assert.equal(error.name, "ObservationInputError");
    assert.equal(error.diagnostic.code, code);
    assert.equal(error.diagnostic.severity, "error");
    assert.deepEqual(Object.keys(error.diagnostic).sort(), ["code", "field", "path", "projectId", "refs", "severity"]);
    assert.match(error.diagnostic.path, /^($|\/)/);
    for (const [key, value] of Object.entries(details)) assert.deepEqual(error.diagnostic[key], value, key);
    return true;
  });
}

function addRoute(project, id, channel, availability) {
  project.routes ??= [];
  project.routes.push({ id, channel, availability, observationIds: ["route-" + id] });
  project.observations.push(observation("route-" + id, "route", { channel, availability }, { scope: id }));
}

function channelBuilders(field) {
  return {
    whole: (id, value, scope = "project") => observation(id, field, value, { scope }),
    step: (id, stepId, applicability, value, scope = "project") =>
      observation(id, field, value, { scope, requirement: { id: stepId, applicability } }),
    cover: (id, requiredIds, scope = "project") => observation(id, field, null, { scope, requiredIds })
  };
}

const FC = "FIELD_CONFLICT";
const CI = "REQUIREMENT_COVERAGE_INCOMPLETE";
const AU = "REQUIREMENT_APPLICABILITY_UNRESOLVED";
const SU = "SCOPE_UNCONFIRMED";
const RU = "ROUTE_UNRESOLVED";
const DU = "DETERMINATION_UNSUPPORTED";
const TU = "TITLE_UNVERIFIED";
const CC = "COMPENSATION_CONTEXT_UNREPRESENTED";

function assertChannel(result, field, { value, state = value === "conflicting" ? "conflicting" : "supported",
  hold, events = [], classification }) {
  assert.equal(result.invitations[0].salazarEvidence[field], value);
  assert.equal(fieldOf(result, field).value, value);
  assert.equal(fieldOf(result, field).state, state);
  assert.equal(first(result).reviewHold, hold);
  const actual = result.diagnostics.filter(item => item.field === field).map(({ code, refs }) => [code, refs]);
  assert.deepEqual(actual, events);
  const ranked = row(result);
  assert.equal(ranked.classification, classification);
  const [label, violation] = channelLabels[field];
  if (value === "external") assert.ok(ranked.reasons.includes(violation));
  if (value === "conflicting") assert.ok(ranked.reasons.includes(label + " evidence conflicts"));
  if (value === "unknown") assert.ok(ranked.reasons.includes(label + " is unconfirmed"));
  if (value === "voice123") assert.ok(!ranked.reasons.includes(violation));
}

describe("independent contract fixtures", () => {
  test("fully supported invitation, strict projection and attributed provenance", () => {
    const { input, expected } = fixture.supported;
    const result = normalizeDiscoveryEvidence(input);
    assert.deepEqual(result.batch, expected.batch);
    assert.deepEqual(result.invitations, [expected.invitation]);
    assert.deepEqual(result.diagnostics, expected.diagnostics);
    const project = first(result);
    assert.deepEqual(Object.keys(result).sort(), ["batch", "diagnostics", "invitations", "projects"]);
    assert.deepEqual(Object.keys(project).sort(), ["determinations", "duplicateSources", "fields", "observations",
      "preview", "projectId", "readStatus", "reviewHold", "routeId", "routeSelectionReason", "routes", "titleHint", "url"]);
    assert.deepEqual(project.observations, input.projects[0].observations);
    assert.deepEqual(project.determinations, input.projects[0].determinations);
    assert.equal(project.reviewHold, expected.reviewHold);
    assert.equal(project.routeSelectionReason, "NO_ROUTES");
    assert.deepEqual(fieldOf(result, "scriptAvailability"), {
      value: "verified_usable", state: "supported", observationIds: ["copy", "usable"], determinationIds: ["copy-review"]
    });
    assert.deepEqual(fieldOf(result, "rightsStatus").determinationIds, ["rights-review"]);
    const ranked = row(result);
    assert.equal(ranked.classification, expected.classification);
    assert.deepEqual(ranked.fit, { score: 4, preferredMatches: ["commercials"], avoidMatches: [], budgetFit: "meets_target" });
  });

  test("Colgate historical-summary reconstruction preserves all mandatory violations and review reasons", () => {
    const { input, expected } = fixture.colgate;
    const result = normalizeDiscoveryEvidence(input);
    const [invitation] = result.invitations;
    assert.equal(invitation.projectId, "IO0BMO0L0");
    assert.equal(invitation.title, "Colgate – Nativos Colombia o Mexico");
    assert.deepEqual(invitation.budget, { amount: 2000, currency: "USD" });
    assert.equal(invitation.deadline, null);
    assert.equal(invitation.proposalStatus, "unknown");
    assert.equal(invitation.rightsStatus, "review_required");
    assert.deepEqual(invitation.salazarEvidence, expected.salazarEvidence);
    assert.equal(result.batch.status, expected.batchStatus);
    assert.equal(first(result).reviewHold, expected.reviewHold);
    assert.equal(first(result).observations.find(item => item.id === "pc").observer, "fixture-colgate-summary");
    assert.deepEqual(fieldOf(result, "transactionChannel").observationIds, ["tx"]);
    assert.deepEqual(first(result).observations.find(item => item.id === "ref").value, { kind: "external_reference" });
    assert.equal(row(result).classification, expected.classification);
    assert.deepEqual(row(result).reasons, expected.reasons);
  });
});

describe("2A-R1 whole-field preservation across all mandatory channels", () => {
  for (const field of channelFields) {
    const { whole, step, cover } = channelBuilders(field);
    const external = whole("x", "external");
    const platform = whole("v", "voice123");
    const initial = step("a", "initial", "required", "voice123");
    const followup = step("b", "callback", "required", "voice123");
    const callback = step("b", "callback", "required", "external");
    const optional = step("o", "copy", "optional", "external");
    const all = cover("c", ["initial", "callback"]);
    const one = cover("c", ["initial"]);
    const cases = [
      ["W1 whole external alone", [external], "external", false, [], "ineligible"],
      ["W2 compatible initial step", [external, initial], "external", false, [], "ineligible"],
      ["W3 multiple compatible steps", [external, initial, followup], "external", false, [], "ineligible"],
      ["W4 omitted required step", [external, initial, followup, one], "external", true,
        [[FC, ["b", "c"]], [CI, ["b", "c"]]], "ineligible"],
      ["W5 complete granular contradiction", [external, initial, followup, all], "conflicting", true,
        [[FC, ["x", "a", "b", "c"]]], "needs_review"],
      ["W6 opposing coverage sets", [external, initial, followup, all, cover("d", ["initial"])], "external", true,
        [[FC, ["b", "c", "d"]], [CI, ["b", "c", "d"]]], "ineligible"],
      ["W7 opposed whole assertions", [external, platform], "conflicting", false, [[FC, ["x", "v"]]], "needs_review"],
      ["W8 independent external callback", [external, platform, callback], "external", true,
        [[FC, ["x", "v"]], [FC, ["v", "b"]]], "ineligible"],
      ["W9 disputed callback", [callback, step("y", "callback", "required", "voice123")], "conflicting", true,
        [[FC, ["b", "y"]], [CI, ["b", "y"]]], "needs_review"],
      ["W10 unknown applicability", [external, step("u", "extra", "unknown", "unknown")], "external", true,
        [[AU, ["u"]], [CI, ["u"]]], "ineligible"],
      ["W11 optional outside step and a separate mandatory violation", [external, optional], "external", false, [], "ineligible"],
      ["W12 complete platform coverage with optional outside step", [initial, optional, one], "voice123", false, [], "eligible"]
    ];
    for (const [name, claims, value, hold, events, classification] of cases) {
      test(field + " " + name, () => {
        const project = supported();
        replace(project, field, ...claims);
        const result = normalize(project);
        assertChannel(result, field, { value, hold, events, classification });
        assert.deepEqual(fieldOf(result, field).observationIds, claims.map(item => item.id));
        assert.deepEqual(first(result).observations.filter(item => item.field === field), claims);
      });
    }

    test(field + " repeated W9 evidence and determinations remain one disputed step", () => {
      const project = supported();
      const y = step("y", "callback", "required", "voice123");
      const z = step("z", "callback", "required", "external");
      replace(project, field, callback, y, z);
      project.determinations.push(
        decision("review-external", field, "external", ["z"], { requirement: z.requirement }),
        decision("review-platform", field, "voice123", ["y"], { requirement: y.requirement })
      );
      const result = normalize(project);
      assertChannel(result, field, { value: "conflicting", hold: true, classification: "needs_review",
        events: [[FC, ["b", "y", "z"]], [CI, ["b", "y", "z"]]] });
      assert.deepEqual(fieldOf(result, field).determinationIds, ["review-external", "review-platform"]);
    });

    const unknownCases = [
      ["whole favorable plus incomplete granular evidence", [platform, initial], [[CI, ["a"]]], "ambiguous", true],
      ["explicit whole unknown", [whole("u", "unknown")], [], "unknown", false],
      ["required step with no known channel", [step("u", "initial", "required", "unknown"), one],
        [[CI, ["u", "c"]]], "ambiguous", true],
      ["coverage includes an optional step", [initial, optional, cover("c", ["initial", "copy"])],
        [[FC, ["o", "c"]], [CI, ["o", "c"]]], "ambiguous", true],
      ["listed step has unresolved applicability", [step("u", "initial", "unknown", "voice123"), one],
        [[AU, ["u"]], [CI, ["u", "c"]]], "ambiguous", true]
    ];
    for (const [name, claims, events, state, hold] of unknownCases) {
      test(field + " " + name, () => {
        const project = supported();
        replace(project, field, ...claims);
        assertChannel(normalize(project), field, { value: "unknown", state, hold, events, classification: "needs_review" });
      });
    }
  }
});

describe("route selection, universal applicability, and excluded evidence", () => {
  for (const field of channelFields) {
    const { whole, step, cover } = channelBuilders(field);

    test(field + " R1 selected platform evidence does not borrow from the outside route", () => {
      const project = supported();
      addRoute(project, "v", "voice123", "alternative");
      addRoute(project, "e", "external", "alternative");
      replace(project, field, step("a", "initial", "required", "voice123", "v"),
        cover("c", ["initial"], "v"), whole("x", "external", "e"));
      const result = normalize(project);
      assertChannel(result, field, { value: "voice123", hold: false, classification: "eligible" });
      assert.equal(first(result).routeId, "v");
      assert.equal(first(result).routeSelectionReason, "UNIQUE_VOICE123_ALTERNATIVE");
      assert.deepEqual(first(result).routes, project.routes);
      assert.deepEqual(fieldOf(result, field).observationIds, ["a", "c"]);
      assert.deepEqual(first(result).observations.find(item => item.id === "x"), whole("x", "external", "e"));
    });

    test(field + " R2 project-wide external assertion survives a selected compliant initial step", () => {
      const project = supported();
      addRoute(project, "v", "voice123", "required");
      addRoute(project, "e", "external", "alternative");
      replace(project, field, whole("x", "external"), step("a", "initial", "required", "voice123", "v"));
      const result = normalize(project);
      assertChannel(result, field, { value: "external", hold: false, classification: "ineligible" });
      assert.equal(first(result).routeSelectionReason, "VERIFIED_REQUIRED_ROUTE");
      assert.deepEqual(fieldOf(result, field).observationIds, ["x", "a"]);
    });

    test(field + " R3 unknown scope cannot establish either known channel", () => {
      for (const value of ["external", "voice123"]) {
        const project = supported();
        replace(project, field, whole("u", value, "unknown"));
        assertChannel(normalize(project), field, { value: "unknown", state: "ambiguous", hold: false,
          events: [[SU, ["u"]]], classification: "needs_review" });
      }
    });

    test(field + " R4 unresolved arrangement retains an independently universal violation", () => {
      const project = supported();
      addRoute(project, "a", "voice123", "alternative");
      addRoute(project, "b", "voice123", "alternative");
      replace(project, field, whole("x", "external"), whole("v", "voice123", "a"));
      const result = normalize(project);
      assertChannel(result, field, { value: "external", hold: true, classification: "ineligible" });
      assert.equal(first(result).routeId, null);
      assert.equal(first(result).routeSelectionReason, "MULTIPLE_VOICE123_ALTERNATIVES");
      assert.deepEqual(result.diagnostics, [{
        code: RU, severity: "review", projectId: "BASE1", field: null, path: "/projects/0/routes", refs: ["route-a", "route-b"]
      }]);
      assert.deepEqual(fieldOf(result, field).observationIds, ["x"]);
    });
  }

  for (const [name, declarations, reason, contradictory] of [
    ["multiple required", [["a", "voice123", "required"], ["b", "external", "required"]], "MULTIPLE_REQUIRED_ROUTES"],
    ["unknown before multiple required", [["a", "voice123", "required"], ["b", "external", "required"],
      ["u", "unknown", "unknown"]], "UNKNOWN_ROUTE_APPLICABILITY"],
    ["known contradictory declarations before unknown", [["a", "voice123", "alternative"],
      ["b", "unknown", "unknown"]], "CONTRADICTORY_ROUTE_DECLARATIONS", true],
    ["only external alternatives", [["a", "external", "alternative"]], "NO_SUPPORTED_VOICE123_ALTERNATIVE"]
  ]) {
    test(name, () => {
      const project = supported();
      declarations.forEach(args => addRoute(project, ...args));
      if (contradictory) {
        project.routes[0].observationIds.push("opposed");
        project.observations.push(observation("opposed", "route", { channel: "external", availability: "alternative" }, { scope: "a" }));
      }
      const result = normalize(project);
      assert.equal(first(result).routeId, null);
      assert.equal(first(result).routeSelectionReason, reason);
      assert.equal(first(result).reviewHold, true);
      assert.deepEqual(first(result).routes, project.routes);
      assert.deepEqual(result.diagnostics[0].refs, project.observations.filter(item => item.field === "route").map(item => item.id));
      assert.equal(row(result).classification, "eligible");
    });
  }

  test("a route label and an outside escrow source supply no selected-route security or terms", () => {
    const project = supported();
    addRoute(project, "v", "voice123", "alternative");
    addRoute(project, "e", "external", "alternative");
    replace(project, "paymentSecurity", observation("outside", "paymentSecurity", "secured", { scope: "e" }));
    replace(project, "paymentTerms");
    const result = normalize(project);
    assert.equal(result.invitations[0].salazarEvidence.paymentSecurity, "unknown");
    assert.equal(result.invitations[0].salazarEvidence.paymentTerms, "unknown");
    assert.equal(first(result).routeId, "v");
    assert.equal(row(result).classification, "needs_review");
  });

  test("unknown-scope claims that could change known evidence hold without contaminating it", () => {
    const project = supported();
    project.observations.push(observation("scope", "paymentChannel", "external", { scope: "unknown" }));
    assertChannel(normalize(project), "paymentChannel", { value: "voice123", hold: true,
      events: [[SU, ["scope"]]], classification: "eligible" });
  });

  test("unknown-scope step cannot confirm or contradict a mandatory external requirement", () => {
    const field = "paymentChannel";
    const { whole, step } = channelBuilders(field);
    const project = supported();
    replace(project, field, whole("x", "external"), step("u", "extra", "required", "voice123", "unknown"));
    const result = normalize(project);
    assertChannel(result, field, { value: "external", hold: true,
      events: [[SU, ["u"]]], classification: "ineligible" });
    assert.deepEqual(fieldOf(result, field).observationIds, ["x", "u"]);
  });

  test("universal and route-specific claims about the same step conflict, while separate steps coexist", () => {
    const { step } = channelBuilders("auditionChannel");
    for (const [id, value, hold, events, classification] of [
      ["callback", "conflicting", true, [[FC, ["a", "b"]], [CI, ["a", "b"]]], "needs_review"],
      ["initial", "external", false, [], "ineligible"]
    ]) {
      const project = supported();
      addRoute(project, "v", "voice123", "required");
      replace(project, "auditionChannel", step("a", "callback", "required", "external"),
        step("b", id, "required", "voice123", "v"));
      assertChannel(normalize(project), "auditionChannel", { value, hold, events, classification });
    }
  });
});


describe("AUD-COR-01 unknown-scope mandatory applicability", () => {
  for (const field of channelFields) {
    test(field + " preserves eligibility while holding an explicitly required unresolved step", () => {
      const project = supported();
      const control = normalize(project);
      assertChannel(control, field, { value: "voice123", hold: false, classification: "eligible" });
      assert.deepEqual(control.diagnostics, []);

      const { step } = channelBuilders(field);
      const unresolved = step("unresolved-callback", "callback", "required", "unknown", "unknown");
      const index = project.observations.length;
      project.observations.push(unresolved);
      const result = normalize(project);

      assert.deepEqual(result.batch, control.batch);
      assert.equal(result.batch.evaluationAllowed, true);
      assert.deepEqual(result.invitations, control.invitations);
      assertChannel(result, field, { value: "voice123", hold: true, classification: "eligible",
        events: [[SU, ["unresolved-callback"]]] });
      assert.deepEqual(result.diagnostics, [{
        code: SU, severity: "review", projectId: "BASE1", field,
        path: "/projects/0/observations/" + index, refs: ["unresolved-callback"]
      }]);
      assert.equal(first(result).routeId, null);
      assert.deepEqual(first(result).observations.find(item => item.id === unresolved.id), unresolved);
      assert.deepEqual(fieldOf(result, field).observationIds,
        [...fieldOf(control, field).observationIds, unresolved.id]);
    });
  }

  const field = "auditionChannel";
  const { whole, step, cover } = channelBuilders(field);
  const requiredUnknown = () => step("unresolved", "callback", "required", "unknown", "unknown");

  for (const [name, item] of [
    ["optional step with unknown channel", step("optional", "callback", "optional", "unknown", "unknown")],
    ["scalar with unknown channel", whole("scalar", "unknown", "unknown")],
    ["step with both applicability and channel unknown", step("uncertain", "callback", "unknown", "unknown", "unknown")]
  ]) {
    test("AUD-COR-01 leaves existing uncertainty behavior intact for " + name, () => {
      const project = supported();
      const control = normalize(project);
      project.observations.push(item);
      const result = normalize(project);
      assert.deepEqual(result.invitations, control.invitations);
      assert.deepEqual(result.diagnostics, control.diagnostics);
      assertChannel(result, field, { value: "voice123", hold: false, classification: "eligible" });
      assert.deepEqual(first(result).observations.find(entry => entry.id === item.id), item);
      assert.ok(fieldOf(result, field).observationIds.includes(item.id));
    });
  }

  test("AUD-COR-01 preserves an independently confirmed mandatory external step", () => {
    const project = supported();
    const external = step("confirmed-external", "initial", "required", "external");
    const unresolved = requiredUnknown();
    replace(project, field, external, unresolved);
    const result = normalize(project);
    assertChannel(result, field, { value: "external", hold: true, classification: "ineligible",
      events: [[SU, ["unresolved"]]] });
    assert.deepEqual(fieldOf(result, field).observationIds, ["confirmed-external", "unresolved"]);
    assert.deepEqual(first(result).observations.filter(item => item.field === field), [external, unresolved]);
  });

  test("AUD-COR-01 composes independently with an unverified title hold", () => {
    for (const [titleMissing, scopeMissing, expectedCodes] of [
      [false, true, [SU]], [true, false, [TU]], [true, true, [TU, SU]]
    ]) {
      const project = supported();
      if (titleMissing) replace(project, "title");
      if (scopeMissing) project.observations.push(requiredUnknown());
      const result = normalize(project);
      assert.equal(first(result).reviewHold, true);
      assert.equal(row(result).classification, "eligible");
      assert.deepEqual(codes(result), expectedCodes);
      if (titleMissing) assert.equal(result.invitations[0].title, "BASE1");
      if (scopeMissing) assert.deepEqual(result.diagnostics.find(item => item.code === SU).refs, ["unresolved"]);
    }
  });

  test("AUD-COR-01 preserves outcomes and diagnostic membership when observations reverse", () => {
    const project = supported();
    project.observations.push(requiredUnknown(), step("second", "followup", "required", "unknown", "unknown"));
    const inputs = [project, { ...project, observations: [...project.observations].reverse() }];
    for (const [input, refs] of [[inputs[0], ["unresolved", "second"]], [inputs[1], ["second", "unresolved"]]]) {
      const result = normalize(input);
      assertChannel(result, field, { value: "voice123", hold: true, classification: "eligible", events: [[SU, refs]] });
      assert.equal(result.diagnostics.length, 1);
      assert.deepEqual(fieldOf(result, field).observationIds,
        input === project ? ["audition", ...refs] : [...refs, "audition"]);
    }
  });

  test("AUD-COR-01 holds a null-channel excerpt with explicit required-step metadata", () => {
    const project = supported();
    const unresolved = { ...excerpt("unresolved", field, "Callback channel unconfirmed."),
      scope: "unknown", requirement: { id: "callback", applicability: "required" } };
    project.observations.push(unresolved);
    const result = normalize(project);
    assertChannel(result, field, { value: "voice123", hold: true, classification: "eligible",
      events: [[SU, ["unresolved"]]] });
    assert.deepEqual(first(result).observations.find(item => item.id === "unresolved"), unresolved);

    project.observations.pop();
    project.observations.push(step("invalid-null", "callback", "required", null, "unknown"));
    expectFatal(() => normalize(project));
  });

  test("AUD-COR-01 remains an independent hold alongside an exempt optional-step conflict", () => {
    const project = supported();
    replace(project, field, step("initial", "initial", "required", "voice123"), cover("coverage", ["initial"]),
      step("optional-platform", "copy", "optional", "voice123"), step("optional-external", "copy", "optional", "external"));
    const optionalConflict = [FC, ["optional-platform", "optional-external"]];
    assertChannel(normalize(project), field, { value: "voice123", hold: false, classification: "eligible",
      events: [optionalConflict] });

    project.observations.push(requiredUnknown());
    assertChannel(normalize(project), field, { value: "voice123", hold: true, classification: "eligible",
      events: [optionalConflict, [SU, ["unresolved"]]] });
  });
});

describe("event-local review holds", () => {
  const field = "auditionChannel";
  const { step, cover } = channelBuilders(field);
  const optional = [step("o1", "copy", "optional", "voice123"), step("o2", "copy", "optional", "external")];
  const settled = [step("a", "initial", "required", "voice123"), cover("c", ["initial"]), ...optional];

  for (const [name, setup, value, state, hold, events, classification, extraCodes] of [
    ["H1 optional-only conflict", () => settled, "voice123", "supported", false, [[FC, ["o1", "o2"]]], "eligible", []],
    ["H2 disputed applicability", () => [step("a", "copy", "required", "external"), optional[1]],
      "conflicting", "conflicting", true, [[FC, ["a", "o2"]], [AU, ["a", "o2"]], [CI, ["a", "o2"]]], "needs_review", []],
    ["H3 unresolved title", project => { replace(project, "title"); return settled; },
      "voice123", "supported", true, [[FC, ["o1", "o2"]]], "eligible", [TU]],
    ["H4 incomplete coverage", () => [settled[0], ...optional], "unknown", "ambiguous", true,
      [[FC, ["o1", "o2"]], [CI, ["a", "o1", "o2"]]], "needs_review", []],
    ["H5 unsupported determination", project => {
      project.determinations.push(decision("unsupported", "paymentSecurity", "unsecured", ["security"]));
      return settled;
    }, "voice123", "supported", true, [[FC, ["o1", "o2"]]], "eligible", [DU]],
    ["H6 separate confirmed external step", () => [
      step("a", "initial", "required", "external"), cover("c", ["initial"]), ...optional
    ], "external", "supported", false, [[FC, ["o1", "o2"]]], "ineligible", []],
    ["H7 unresolved route declarations", project => {
      addRoute(project, "v", "voice123", "alternative");
      addRoute(project, "w", "voice123", "alternative");
      return optional.map(item => ({ ...item, scope: "v" }));
    }, "unknown", "missing", true, [], "needs_review", [RU]]
  ]) {
    test(name, () => {
      const project = supported();
      const claims = setup(project);
      replace(project, field, ...claims);
      const result = normalize(project);
      assertChannel(result, field, { value, state, hold, events, classification });
      assert.deepEqual(result.diagnostics.filter(item => item.field !== field).map(item => item.code), extraCodes);
      assert.deepEqual(first(result).observations.filter(item => item.field === field), claims);
    });
  }

  test("independent hold triggers and separate optional and mandatory diagnostic events", () => {
    const project = supported();
    replace(project, "title");
    project.observations.push(observation("another-description", "description", "This is unpaid work."));
    replace(project, field, ...optional,
      step("a", "callback", "required", "external"), step("b", "callback", "required", "voice123"));
    const result = normalize(project);
    assertChannel(result, field, { value: "conflicting", hold: true, classification: "needs_review",
      events: [[FC, ["o1", "o2"]], [FC, ["a", "b"]], [CI, ["a", "b"]]] });
    assert.deepEqual(codes(result), [TU, FC, FC, FC, CI]);
  });
});

describe("strict native validation and fatal errors", () => {
  test("version, shape, type, and presence constraints", () => {
    for (const [input, code] of [
      [null], [true], [[]], [{}], [batch([], "unknown", { schemaVersion: 2 }), "UNSUPPORTED_SCHEMA_VERSION"],
      [batch([], "unknown", { schemaVersion: "1" })], [batch([], "unknown", { schemaVersion: undefined })],
      [batch([], "unknown", { source: "preview" })], [batch([], "unknown", { other: 1 })],
      [batch({}, "unknown")], [batch(null, "unknown")], [batch([], "other")],
      [batch([], "unknown", { discovered: -1 })], [batch([], "unknown", { discovered: null })],
      [batch([], "unknown", { discovered: 1.5 })], [batch([], "unknown", { discovered: Infinity })],
      [batch([])], [batch([supported()], "confirmed_empty")], [batch([], "failed", { discovered: 0 })],
      [batch([supported()], "complete", { discovered: 2 })],
      [batch([supported()], "partial", { discovered: 0 })],
      [batch([{ projectId: "BAD", readStatus: "failed", observations: [observation("a", "title", "Unexpected")] }], "partial")],
      [batch([{ projectId: "BAD", readStatus: "unverified" }], "partial")],
      [batch([{ projectId: "BAD", readStatus: "observed", observations: [null] }])],
      [batch([{ projectId: "BAD", readStatus: "observed", observations: [{ ...observation("a", "title", "Text"), metadata: {} }] }])],
      [batch([{ projectId: "BAD", readStatus: "observed", duplicateSources: null }])]
    ]) expectFatal(() => normalizeDiscoveryEvidence(input), code);
  });

  test("accepts plain and null-prototype records at multiple depths", () => {
    const toNull = value => {
      if (Array.isArray(value)) return value.map(toNull);
      if (value && typeof value === "object") {
        return Object.assign(Object.create(null), Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toNull(item)])));
      }
      return value;
    };
    assert.deepEqual(normalizeDiscoveryEvidence(toNull(fixture.supported.input)).invitations,
      [fixture.supported.expected.invitation]);
  });

  test("rejects accessors without invoking them, inherited data, and unsafe array shapes", () => {
    let calls = 0;
    const access = () => { calls++; throw new Error("accessor invoked"); };
    const accessor = Object.defineProperty(batch([], "unknown"), "projects", { get: access, enumerable: true });
    const setter = Object.defineProperty(batch([], "unknown"), "source", { set: access, enumerable: true });
    const arrayAccessor = Object.defineProperty([null], 0, { get: access, enumerable: true });
    const hiddenIndex = Object.defineProperty([supported()], 0, { enumerable: false });
    const hidden = Object.defineProperty(batch([], "unknown"), "hidden", { value: true });
    const nested = supported();
    Object.defineProperty(nested.observations[2].value, "amount", { get: access, enumerable: true });
    const polluted = batch([], "unknown");
    Object.defineProperty(polluted, "__proto__", { enumerable: true, value: { polluted: true } });
    const cyclic = batch([], "unknown");
    cyclic.projects.push(cyclic);
    for (const input of [accessor, setter, hidden, polluted, cyclic, batch([undefined], "unknown"),
      batch(arrayAccessor), batch(hiddenIndex), batch(Array(1)), batch(Object.assign([], { extra: true })),
      batch(Object.assign([], { [Symbol("extra")]: true })), batch([nested]),
      Object.create(batch([], "unknown")), Object.assign(Object.create({ inherited: true }), batch([], "unknown")),
      { ...batch([], "unknown"), [Symbol("extra")]: true },
      { ...batch([], "unknown"), constructor: { prototype: { polluted: true } } }
    ]) expectFatal(() => normalizeDiscoveryEvidence(input));
    assert.equal(calls, 0);
    assert.equal(Object.hasOwn({}, "polluted"), false);
  });

  test("fatal error aborts an otherwise partially valid batch", () => {
    const bad = supported();
    bad.projectId = "bad-id";
    expectFatal(() => normalizeDiscoveryEvidence(batch([supported(), bad], "partial")),
      "INVALID_PROJECT_ID", { path: "/projects/1/projectId", field: "projectId" });
  });
});

describe("canonical identity and reference integrity", () => {
  test("trimmed mixed-case IDs and case-folded duplicates spanning failed reads", () => {
    const project = supported();
    project.projectId = "  bAsE1  ";
    const result = normalize(project);
    assert.equal(first(result).projectId, "BASE1");
    assert.equal(result.invitations[0].projectId, "BASE1");
    assert.equal(first(result).url, project.url);
    for (const status of ["observed", "failed"]) {
      expectFatal(() => normalizeDiscoveryEvidence(batch([project, { projectId: "base1", readStatus: status }], "partial")),
        "DUPLICATE_PROJECT_ID", { path: "/projects/1/projectId", projectId: "BASE1" });
    }
    for (const id of ["", "  ", "slash/name", "name-id", "İD", 123]) {
      expectFatal(() => normalize({ projectId: id, readStatus: "observed" }), "INVALID_PROJECT_ID");
    }
  });

  test("URL identity and canonical path validation do not echo rejected payloads", () => {
    const valid = "https://voice123.com/projects/BASE1/synthetic/specs";
    const project = supported();
    project.url = valid;
    assert.equal(first(normalize(project)).url, valid);
    expectFatal(() => normalize({ ...project, url: valid.replace("BASE1", "OTHER") }),
      "PROJECT_ID_MISMATCH", { projectId: "BASE1", field: "projectId", path: "/projects/0/url" });
    for (const url of [
      valid.replace("voice123.com", "example.invalid"), valid.replace("https:", "http:"),
      valid.replace("/specs", "/other"), valid.replace("voice123.com", "fixture:synthetic@voice123.com"),
      valid + "?token=synthetic-marker", valid + "#synthetic-marker",
      valid.replace("voice123.com", "voice123.com:8443"), valid.replace("voice123.com", "voice123.com:443"),
      valid.replace("synthetic", "%73ynthetic"), valid.replace("BASE1", "%42ASE1"), valid.replace("synthetic", "..")
    ]) {
      assert.throws(() => normalize({ ...project, url }), error => {
        assert.equal(error.diagnostic.code, "INVALID_INPUT");
        assert.equal(error.diagnostic.path, "/projects/0/url");
        assert.ok(!error.message.includes(url));
        assert.ok(!JSON.stringify(error.diagnostic).includes(url));
        return true;
      });
    }
  });

  test("rejects malformed and out-of-scope route, step, and determination references", () => {
    const { whole, step, cover } = channelBuilders("auditionChannel");
    for (const [setup, code = "INVALID_REFERENCE"] of [
      [p => addRoute(p, "project", "voice123", "required"), "INVALID_INPUT"],
      [p => { addRoute(p, "seen", "voice123", "required"); addRoute(p, "seen", "voice123", "required"); }, "INVALID_INPUT"],
      [p => p.observations.push(p.observations[0]), "INVALID_INPUT"],
      [p => p.determinations.push(p.determinations[0]), "INVALID_INPUT"],
      [p => p.determinations.push(decision("bad", "paymentSecurity", "secured", ["absent"]))],
      [p => p.determinations.push(decision("bad", "paymentSecurity", "secured", ["security", "security"]))],
      [p => { addRoute(p, "v", "voice123", "required"); p.determinations.push(
        decision("bad", "paymentSecurity", "secured", ["security"], { scope: "v" })); }],
      [p => p.observations.push(whole("stray", "voice123", "undeclared"))],
      [p => p.observations.push(step("bad", "call back", "required", "voice123")), "INVALID_INPUT"],
      [p => p.observations.push(cover("bad", ["absent"]))],
      [p => p.observations.push(step("s", "one", "required", "voice123"), cover("bad", ["one", "one"]))],
      [p => p.observations.push(observation("s", "paymentChannel", "voice123",
        { requirement: { id: "one", applicability: "required" } }), cover("bad", ["one"]))],
      [p => { addRoute(p, "v", "voice123", "alternative"); addRoute(p, "e", "external", "alternative");
        p.observations.push(step("s", "initial", "required", "voice123", "e"), cover("bad", ["initial"], "v")); }],
      [p => { addRoute(p, "v", "voice123", "required"); p.routes[0].observationIds = ["title"]; }],
      [p => { addRoute(p, "v", "voice123", "required"); p.routes[0].channel = "external"; }],
      [p => { addRoute(p, "v", "voice123", "required"); p.observations.push(
        observation("unindexed", "route", { channel: "external", availability: "required" }, { scope: "v" })); }]
    ]) {
      const project = supported();
      setup(project);
      expectFatal(() => normalize(project), code);
    }
    const other = { projectId: "OTHER", readStatus: "observed", observations: [observation("other-only", "paymentSecurity", "secured")] };
    const project = supported();
    project.determinations.push(decision("cross", "paymentSecurity", "secured", ["other-only"]));
    expectFatal(() => normalizeDiscoveryEvidence(batch([project, other])), "INVALID_REFERENCE",
      { projectId: "BASE1", field: "paymentSecurity", path: "/projects/0/determinations/2/observationIds/0" });
  });
});

describe("operator attribution and adjudication", () => {
  test("operator label is required exactly on direct observations and rejected before corroboration", () => {
    for (const observer of [undefined, null, "", " ", "a@example.invalid", "a b", "a".repeat(65), 42]) {
      const item = observation("bad", "paymentSecurity", "secured", { method: "operator_observed" });
      if (observer !== undefined) item.observer = observer;
      const project = supported();
      replace(project, "paymentSecurity", item);
      expectFatal(() => normalize(project), "INVALID_INPUT", { path: "/projects/0/observations/16/observer" });
    }
    for (const item of [
      observation("bad", "paymentSecurity", "secured", { observer: "fixture-operator" }),
      { ...excerpt("bad", "paymentSecurity", "Unknown status."), observer: "fixture-operator" },
      { ...excerpt("bad", "paymentSecurity", "Unknown status."), value: "secured" }
    ]) {
      const project = supported();
      replace(project, "paymentSecurity", item);
      expectFatal(() => normalize(project));
    }
  });

  test("typed corroboration links attribution; weak or incompatible evidence holds without promoting a claim", () => {
    const project = supported();
    const explicit = observation("explicit", "paymentSecurity", "secured",
      { method: "operator_observed", observer: "fixture-observer" });
    replace(project, "paymentSecurity", explicit, excerpt("reported", "paymentSecurity", "Positive budget stated."));
    project.determinations.push(
      decision("valid", "paymentSecurity", "secured", ["explicit"]),
      decision("favor", "paymentSecurity", "secured", ["reported"]),
      decision("oppose", "paymentSecurity", "unsecured", ["explicit"]),
      decision("wrong-field", "paymentSecurity", "unsecured", ["budget"])
    );
    const result = normalize(project);
    assert.equal(first(result).reviewHold, true);
    assert.deepEqual(fieldOf(result, "paymentSecurity"), {
      value: "secured", state: "supported", observationIds: ["explicit", "reported"], determinationIds: ["valid"]
    });
    assert.deepEqual(result.diagnostics, [
      { code: DU, severity: "review", projectId: "BASE1", field: "paymentSecurity", path: "/projects/0/determinations/3", refs: ["reported", "favor"] },
      { code: DU, severity: "review", projectId: "BASE1", field: "paymentSecurity", path: "/projects/0/determinations/4", refs: ["explicit", "oppose"] },
      { code: DU, severity: "review", projectId: "BASE1", field: "paymentSecurity", path: "/projects/0/determinations/5", refs: ["budget", "wrong-field"] }
    ]);
    assert.deepEqual(first(result).observations.find(item => item.id === "explicit"), explicit);
    assert.equal(row(result).classification, "eligible");
  });

  test("an attributed unknown claim cannot substantiate favorable security", () => {
    const project = supported();
    replace(project, "paymentSecurity", observation("weak", "paymentSecurity", "unknown", {
      method: "operator_observed", observer: "fixture-observer", section: "budget display", excerpt: "USD 250 displayed."
    }));
    project.determinations.push(decision("favor", "paymentSecurity", "secured", ["weak"]));
    const result = normalize(project);
    assert.equal(fieldOf(result, "paymentSecurity").value, "unknown");
    assert.deepEqual(fieldOf(result, "paymentSecurity").determinationIds, []);
    assert.equal(first(result).reviewHold, true);
    assert.ok(codes(result).includes(DU));
    assert.equal(row(result).classification, "needs_review");
  });
});

describe("evaluator fields and mandatory evidence", () => {
  test("literal ordinary text survives, while an unverified hint or conflict uses canonical title fallback", () => {
    const project = supported();
    replace(project, "title", observation("literal-title", "title", "unknown"));
    replace(project, "description", observation("literal-description", "description", "unknown"));
    let result = normalize(project);
    assert.equal(result.invitations[0].title, "unknown");
    assert.equal(result.invitations[0].description, "unknown");
    assert.equal(fieldOf(result, "title").state, "supported");
    assert.equal(first(result).reviewHold, false);
    project.titleHint = "Unverified display text";
    replace(project, "title");
    result = normalize(project);
    assert.equal(result.invitations[0].title, "BASE1");
    assert.equal(first(result).titleHint, project.titleHint);
    assert.deepEqual(codes(result), [TU]);
    assert.equal(first(result).reviewHold, true);
    replace(project, "title", observation("a", "title", "One"), observation("b", "title", "Two"));
    result = normalize(project);
    assert.equal(result.invitations[0].title, "BASE1");
    assert.equal(fieldOf(result, "title").state, "conflicting");
    assert.deepEqual(codes(result), [FC, TU]);
  });

  test("deadline equivalence and uncertainty use absolute instants and explicit timezones", () => {
    const project = supported();
    project.observations.push(observation("same", "deadline", "2026-11-28T10:00:00Z"));
    assert.equal(normalize(project).invitations[0].deadline, "2026-11-28T10:00:00.000Z");
    project.observations.push(observation("other", "deadline", "2026-11-29T10:00:00Z"));
    let result = normalize(project);
    assert.equal(result.invitations[0].deadline, null);
    assert.equal(fieldOf(result, "deadline").state, "conflicting");
    assert.equal(first(result).reviewHold, false);
    replace(project, "deadline", excerpt("relative", "deadline", "One hour remaining"));
    result = normalize(project);
    assert.equal(result.invitations[0].deadline, null);
    assert.equal(fieldOf(result, "deadline").state, "ambiguous");
    assert.equal(first(result).reviewHold, false);
    replace(project, "deadline", observation("unknown", "deadline", null));
    assert.equal(fieldOf(normalize(project), "deadline").state, "unknown");
    for (const value of ["2026-11-28T10:00", "2026-02-30T10:00Z", "one hour remaining", "2026-11-28T10:00-25:00"]) {
      replace(project, "deadline", observation("bad", "deadline", value));
      expectFatal(() => normalize(project));
    }
  });

  test("budget validation rejects malformed numbers and retains unconverted currency and ambiguity", () => {
    const project = supported();
    for (const value of [{ amount: -1, currency: "USD" }, { amount: Infinity, currency: "USD" },
      { amount: NaN, currency: "USD" }, { amount: "100", currency: "USD" },
      { amount: 100, currency: "usd" }, { amount: 100, currency: "$" }]) {
      replace(project, "budget", observation("bad", "budget", value));
      expectFatal(() => normalize(project));
    }
    const foreign = observation("foreign", "budget", { amount: 250, currency: "CAD" });
    replace(project, "budget", foreign);
    assert.deepEqual(normalize(project).invitations[0].budget, { amount: 250, currency: "CAD" });
    for (const value of [{ amount: 200, currency: "CAD" }, { amount: 250, currency: "USD" }]) {
      replace(project, "budget", foreign, observation("other", "budget", value));
      const result = normalize(project);
      assert.equal(result.invitations[0].budget, null);
      assert.equal(fieldOf(result, "budget").state, "conflicting");
      assert.equal(first(result).reviewHold, false);
    }
    replace(project, "budget", observation("unknown", "budget", null));
    assert.equal(fieldOf(normalize(project), "budget").state, "unknown");
    replace(project, "budget", excerpt("symbol", "budget", "$250 in an unspecified currency."));
    const ambiguous = normalize(project);
    assert.equal(ambiguous.invitations[0].budget, null);
    assert.equal(fieldOf(ambiguous, "budget").state, "ambiguous");
  });

  test("placeholder descriptions do not substitute for separate recording copy", () => {
    for (const descriptions of [[], [observation("placeholder", "description", "No description")]]) {
      const project = supported();
      replace(project, "description", ...descriptions);
      const result = normalize(project);
      assert.equal(result.invitations[0].description, null);
      assert.equal(result.invitations[0].scriptText, fixture.supported.expected.invitation.scriptText);
      assert.equal(first(result).reviewHold, false);
      assert.ok(row(result).reasons.includes("Project description is missing"));
    }
  });

  test("copy, instructions, pronunciation, references, placeholders and confirmed absence are distinct", () => {
    const project = supported();
    removeCopyReview(project);
    assert.equal(normalize(project).invitations[0].scriptAvailability, "available");
    assert.equal(row(normalize(project)).classification, "needs_review");
    for (const kind of ["instruction", "pronunciation", "reference", "placeholder"]) {
      replace(project, "scriptText", observation("not-copy", "scriptText", { kind, text: "See role description." }));
      const result = normalize(project);
      assert.equal(result.invitations[0].scriptText, null);
      assert.equal(result.invitations[0].scriptAvailability, "unknown");
      assert.deepEqual(fieldOf(result, "scriptText").observationIds, ["not-copy"]);
      assert.equal(first(result).reviewHold, false);
    }
    replace(project, "scriptText");
    replace(project, "scriptAvailability", observation("missing", "scriptAvailability", "missing"));
    assert.equal(normalize(project).invitations[0].scriptAvailability, "missing");
    const copy = observation("copy", "scriptText", { kind: "copy", text: "A separate actual line for the audition." });
    replace(project, "scriptText", copy);
    let result = normalize(project);
    assert.equal(result.invitations[0].scriptText, null);
    assert.equal(result.invitations[0].scriptAvailability, "unknown");
    assert.equal(fieldOf(result, "scriptAvailability").state, "conflicting");
    assert.deepEqual(fieldOf(result, "scriptAvailability").observationIds, ["missing", "copy"]);
    replace(project, "scriptAvailability");
    project.observations.push(observation("other", "scriptText", { kind: "copy", text: "A competing line for the audition." }));
    result = normalize(project);
    assert.equal(result.invitations[0].scriptText, null);
    assert.equal(result.invitations[0].scriptAvailability, "unknown");
    assert.equal(fieldOf(result, "scriptText").state, "conflicting");
  });

  test("typed usability assertion without cited actual copy cannot promote instructions", () => {
    const project = supported();
    replace(project, "scriptText", observation("copy", "scriptText", { kind: "instruction", text: "See the role description." }));
    replace(project, "scriptLanguage");
    const result = normalize(project);
    assert.equal(result.invitations[0].scriptAvailability, "unknown");
    assert.equal(result.invitations[0].salazarEvidence.scriptLanguage, "unknown");
    assert.equal(first(result).reviewHold, true);
    assert.ok(codes(result).includes(DU));
  });

  test("attachments, invitation status, and proposal status use explicit scoped facts", () => {
    for (const [field, known, opposite] of [
      ["attachmentRequirements", "required", "none"], ["invitationStatus", "revision_requested", "new"],
      ["proposalStatus", "closed", "open"]
    ]) {
      const project = supported();
      replace(project, field, observation("a", field, known));
      assert.equal(normalize(project).invitations[0][field], known);
      project.observations.push(observation("b", field, opposite));
      const result = normalize(project);
      assert.equal(result.invitations[0][field], "unknown");
      assert.equal(fieldOf(result, field).state, "conflicting");
      assert.equal(first(result).reviewHold, false);
      replace(project, field, observation("u", field, "unknown"));
      assert.equal(fieldOf(normalize(project), field).state, "unknown");
    }
  });

  test("credible rights risk survives conflicting favorable review; unsupported clearance holds", () => {
    const project = supported();
    project.observations.push(observation("risk", "rightsStatus", "review_required"));
    let result = normalize(project);
    assert.equal(result.invitations[0].rightsStatus, "review_required");
    assert.equal(fieldOf(result, "rightsStatus").state, "conflicting");
    assert.equal(first(result).reviewHold, false);
    assert.ok(row(result).reasons.includes("Voice rights or usage terms need manual review"));
    replace(project, "rightsStatus", observation("rights", "rightsStatus", "reviewed_no_concerns"));
    result = normalize(project);
    assert.equal(result.invitations[0].rightsStatus, "unknown");
    assert.equal(first(result).reviewHold, true);
    assert.ok(codes(result).includes(DU));
    project.determinations.pop();
    replace(project, "rightsStatus");
    assert.equal(fieldOf(normalize(project), "rightsStatus").state, "missing");
  });

  for (const [field, value, violation] of [
    ["scriptLanguage", "non_english", "Required recording material includes non-English copy"],
    ["scriptLanguage", "mixed", "Required recording material includes non-English copy"],
    ["paymentSecurity", "unsecured", "Payment is unsecured"],
    ["paymentTerms", "nonstandard", "Payment terms are not standard Voice123 secured payment terms"]
  ]) {
    test(field + " " + value + " independently disqualifies", () => {
      const project = supported();
      replace(project, field, observation("violation", field, value));
      const result = normalize(project);
      assert.equal(result.invitations[0].salazarEvidence[field], value);
      assert.equal(first(result).reviewHold, false);
      assert.equal(row(result).classification, "ineligible");
      assert.ok(row(result).reasons.includes(violation));
    });
  }

  for (const [field, label, compliant, contrary] of [
    ["scriptLanguage", "Recording language", "english", "mixed"],
    ["paymentSecurity", "Payment security", "secured", "unsecured"],
    ["paymentTerms", "Payment terms", "platform_standard", "nonstandard"]
  ]) {
    test(field + " missing, explicit unknown, ambiguous and genuinely conflicting evidence", () => {
      for (const [claims, state, value] of [
        [[], "missing", "unknown"],
        [[observation("u", field, "unknown")], "unknown", "unknown"],
        [[excerpt("x", field, field === "paymentTerms" ? "45 days." : "No explicit confirmation." )], "ambiguous", "unknown"],
        [[observation("a", field, compliant), observation("b", field, contrary)], "conflicting", "conflicting"]
      ]) {
        const project = supported();
        replace(project, field, ...claims);
        const result = normalize(project);
        assert.equal(result.invitations[0].salazarEvidence[field], value);
        assert.equal(fieldOf(result, field).state, state);
        assert.equal(first(result).reviewHold, false);
        assert.equal(row(result).classification, "needs_review");
        assert.ok(row(result).reasons.includes(label + (value === "unknown" ? " is unconfirmed" : " evidence conflicts")));
      }
      const project = supported();
      replace(project, field, observation("invalid", field, "conflicting"));
      expectFatal(() => normalize(project));
    });
  }
});

describe("batch completeness and conservative preview translation", () => {
  test("batch status and individual evidence remain separate", () => {
    const failed = { projectId: "FAILED", readStatus: "failed", titleHint: "Unverified title" };
    for (const [input, expected, expectedCodes] of [
      [batch([supported()]), ["complete", null, 1, 1, 0, true], []],
      [batch([supported()], "partial", { discovered: 2 }), ["partial", 2, 1, 1, 0, true], ["BATCH_PARTIAL"]],
      [batch([failed, supported()], "partial", { discovered: 4 }), ["partial", 4, 2, 1, 1, true], ["BATCH_PARTIAL", "PROJECT_READ_FAILED"]],
      [batch([failed], "partial"), ["partial", null, 1, 0, 1, false], ["BATCH_PARTIAL", "PROJECT_READ_FAILED"]],
      [batch([supported()], "unknown"), ["unknown", null, 1, 1, 0, true], ["BATCH_COVERAGE_UNKNOWN"]],
      [batch([], "unknown"), ["unknown", null, 0, 0, 0, false], ["BATCH_COVERAGE_UNKNOWN"]],
      [batch([supported()], "unknown", { discovered: 3 }), ["partial", 3, 1, 1, 0, true], ["BATCH_PARTIAL"]],
      [batch([failed], "unknown"), ["partial", null, 1, 0, 1, false], ["BATCH_PARTIAL", "PROJECT_READ_FAILED"]],
      [batch([], "confirmed_empty", { discovered: 0 }), ["confirmed_empty", 0, 0, 0, 0, true], []],
      [batch([], "failed"), ["failed", null, 0, 0, 0, false], ["DISCOVERY_FAILED"]]
    ]) {
      const [status, discovered, sampled, observed, failedCount, evaluationAllowed] = expected;
      const result = normalizeDiscoveryEvidence(input);
      assert.deepEqual(result.batch, { source: "synthetic", status, discovered, sampled, observed,
        failed: failedCount, evaluationAllowed });
      assert.deepEqual(codes(result), expectedCodes);
      assert.equal(result.projects.length, sampled);
      assert.equal(result.invitations.length, observed);
      if (failedCount) {
        const companion = result.projects.find(project => project.projectId === "FAILED");
        assert.deepEqual(companion, { projectId: "FAILED", readStatus: "failed", url: null,
          titleHint: failed.titleHint, duplicateSources: [], routes: [], routeId: null,
          routeSelectionReason: "PROJECT_READ_FAILED", reviewHold: true, observations: [], determinations: [],
          fields: {}, preview: null });
      }
      if (evaluationAllowed) {
        assert.deepEqual(evaluate(result).map(item => [item.projectId, item.classification]),
          observed ? [["BASE1", "eligible"]] : []);
      }
    }
  });

  test("all preview indicators are retained without promoting display-only claims", () => {
    const { input, expected } = fixture.preview;
    const result = normalizeDiscoveryPreview(input);
    assert.equal(result.batch.status, expected.batchStatus);
    assert.equal(first(result).reviewHold, expected.reviewHold);
    assert.deepEqual(new Set(codes(result)), new Set(expected.diagnosticCodes));
    assert.equal(row(result).classification, expected.classification);
    assert.deepEqual(first(result).duplicateSources, ["Local history", "Google Sheets"]);
    assert.equal(first(result).titleHint, "PRE1");
    assert.deepEqual(first(result).preview, {
      status: "Needs Review", reviewReason: null, fieldStatus: "Valid", fieldCharacters: 120,
      attachments: [{ types: ["PDF"], element: "a" }], rightsFlags: [],
      proposalEligibility: "Yes", invitationStatus: "New invitation", deadline: "1 hour remaining"
    });
    for (const [proposalEligibility, proposalStatus] of [["Yes", "unknown"], ["No", "closed"], ["Unknown", "unknown"]]) {
      for (const fieldStatus of ["Valid", "Missing", "Needs Review"]) {
        const preview = clone(input);
        const item = preview.projects[0];
        Object.assign(item, { title: "Displayed title", fieldStatus, fieldCharacters: fieldStatus === "Valid" ? 120 : 0,
          proposalEligibility, invitationStatus: "Revision requested",
          rightsFlags: ["Permanent usage"], attachments: [] });
        const normalized = normalizeDiscoveryPreview(preview);
        assert.equal(normalized.invitations[0].title, "Displayed title");
        assert.equal(normalized.invitations[0].deadline, null);
        assert.equal(normalized.invitations[0].budget, null);
        assert.equal(normalized.invitations[0].description, null);
        assert.equal(normalized.invitations[0].scriptText, null);
        assert.equal(normalized.invitations[0].scriptAvailability, "unknown");
        assert.equal(normalized.invitations[0].attachmentRequirements, "unknown");
        assert.equal(normalized.invitations[0].invitationStatus, "revision_requested");
        assert.equal(normalized.invitations[0].proposalStatus, proposalStatus);
        assert.equal(normalized.invitations[0].rightsStatus, "review_required");
        assert.deepEqual(normalized.invitations[0].salazarEvidence,
          Object.fromEntries(evidenceFields.map(field => [field, "unknown"])));
        assert.equal(first(normalized).preview.proposalEligibility, proposalEligibility);
        assert.equal(first(normalized).preview.fieldStatus, fieldStatus);
        assert.equal(first(normalized).reviewHold, false);
        assert.equal(row(normalized).classification, proposalStatus === "closed" ? "ineligible" : "needs_review");
      }
    }
    assert.equal(result.invitations[0].invitationStatus, "unknown");
    assert.equal(result.invitations[0].rightsStatus, "unknown");
    assert.equal(result.invitations[0].attachmentRequirements, "unknown");
  });

  test("failed and empty previews use distinct batch shapes and closed validation", () => {
    for (const status of ["configuration_error", "identity_unverified", "identity_mismatch", "dashboard_incomplete",
      "sheets_unverified", "history_unverified", "browser_isolation_unavailable", "discovery_failed"]) {
      const result = normalizeDiscoveryPreview({ status, reason: "synthetic failure" });
      assert.deepEqual(result.batch, { source: "preview", status: "failed", discovered: null, sampled: 0,
        observed: 0, failed: 0, evaluationAllowed: false });
      assert.deepEqual(result.invitations, []);
      assert.deepEqual(result.projects, []);
      assert.deepEqual(result.diagnostics, [{
        code: "DISCOVERY_FAILED", severity: "review", projectId: null, field: null, path: "/status", refs: []
      }]);
    }
    const empty = normalizeDiscoveryPreview({ status: "empty_inbox", discovered: 0, projects: [] });
    assert.equal(empty.batch.status, "confirmed_empty");
    assert.deepEqual(evaluate(empty), []);
    const failed = {
      id: "FAIL1", title: "Failed display", url: "https://voice123.com/projects/FAIL1/synthetic/specs",
      status: "project_read_failed", deadline: "No deadline found", duplicateSources: []
    };
    const result = normalizeDiscoveryPreview({ status: "project_read_failed", discovered: 2, sampled: 2,
      projects: [failed, fixture.preview.input.projects[0]] });
    assert.equal(result.batch.status, "partial");
    assert.equal(result.batch.failed, 1);
    assert.equal(first(result).preview.deadline, "No deadline found");
    assert.equal(first(result).preview.fieldStatus, null);
    assert.equal(first(result).preview.proposalEligibility, null);
    assert.equal(first(result).reviewHold, true);
    assert.deepEqual(result.invitations.map(item => item.projectId), ["PRE1"]);
    const allFailed = normalizeDiscoveryPreview({ status: "project_read_failed", discovered: 2, sampled: 1, projects: [failed] });
    assert.equal(allFailed.batch.evaluationAllowed, false);
    for (const input of [fixture.supported.input, { status: "empty_inbox", discovered: 1, projects: [] },
      { status: "empty_inbox", discovered: 0, sampled: 0, projects: [] },
      { ...fixture.preview.input, sampled: 2 }, { ...fixture.preview.input, status: "project_read_failed" },
      { ...fixture.preview.input, projects: [{ ...fixture.preview.input.projects[0], proposalEligibility: "open" }] },
      { ...fixture.preview.input, projects: [{ ...fixture.preview.input.projects[0], fieldStatus: "Available" }] },
      { ...fixture.preview.input, projects: [{ ...fixture.preview.input.projects[0], proposalCount: 4 }] },
      { ...fixture.preview.input, projects: [failed] }
    ]) expectFatal(() => normalizeDiscoveryPreview(input));
  });
});

describe("compensation context and the existing policy", () => {
  test("omitted material unpaid statement leaves a companion hold even if evaluation stays eligible", () => {
    const project = supported();
    project.observations.push(excerpt("pay-context", "budget", "This is unpaid work."));
    const result = normalize(project);
    assert.equal(result.invitations[0].description, fixture.supported.expected.invitation.description);
    assert.deepEqual(result.invitations[0].budget, { amount: 250, currency: "USD" });
    assert.equal(first(result).reviewHold, true);
    assert.deepEqual(result.diagnostics, [{
      code: CC, severity: "review", projectId: "BASE1", field: "budget",
      path: "/projects/0/observations/17", refs: ["pay-context"]
    }]);
    assert.equal(row(result).classification, "eligible");
  });

  test("applicable unpaid wording retained in description reaches the compensation policy", () => {
    const project = supported();
    replace(project, "description", observation("description", "description", "Regional commercial campaign. This is unpaid work."));
    project.observations.push(excerpt("pay-context", "budget", "This is unpaid work."));
    const result = normalize(project);
    assert.ok(!codes(result).includes(CC));
    assert.equal(first(result).reviewHold, false);
    assert.equal(row(result).classification, "needs_review");
    assert.ok(row(result).reasons.includes("Compensation evidence conflicts; confirm whether the work is paid"));
    assert.equal(row(result).fit.score, 0);
  });

  test("characterization only: disclosed exact-text safeguard flags a benign unrepeated budget excerpt", () => {
    const project = supported();
    replace(project, "budget", observation("amount", "budget", { amount: 500, currency: "USD" }),
      excerpt("benign", "budget", "Budget: USD 500."));
    const result = normalize(project);
    assert.deepEqual(result.invitations[0].budget, { amount: 500, currency: "USD" });
    assert.equal(row(result).classification, "eligible");
    // This records Phase 2B's provisionally accepted safeguard, not a business rule.
    assert.equal(first(result).reviewHold, true);
    assert.ok(result.diagnostics.some(item => item.code === CC && item.refs.includes("benign")));
  });

  test("conflicting descriptions retain both claims and hold without inventing a policy reason", () => {
    const project = supported();
    project.observations.push(observation("unpaid-description", "description", "This is unpaid work."));
    const result = normalize(project);
    assert.equal(result.invitations[0].description, null);
    assert.equal(first(result).reviewHold, true);
    assert.deepEqual(fieldOf(result, "description").observationIds, ["description", "unpaid-description"]);
    assert.equal(fieldOf(result, "description").state, "conflicting");
    assert.equal(row(result).classification, "needs_review");
    assert.ok(row(result).reasons.includes("Project description is missing"));
  });

  for (const [amount, currency, classification, budgetFit, reason] of [
    [0, "USD", "ineligible", "below_target", "Confirmed unpaid work: reported budget is zero"],
    [50, "USD", "needs_review", "below_target", "Reported USD budget is below the preferred target of $100"],
    [100, "USD", "eligible", "meets_target"],
    [150, "USD", "eligible", "meets_target"],
    [50, "CAD", "eligible", "no_target_for_currency"],
    [null, null, "needs_review", "budget_unreported", "Compensation amount is unreported"]
  ]) {
    test("existing compensation policy " + amount + " " + currency, () => {
      const project = supported();
      const budget = amount === null ? null : { amount, currency };
      replace(project, "budget", observation("amount", "budget", budget));
      const result = normalize(project);
      assert.deepEqual(result.invitations[0].budget, budget);
      assert.equal(first(result).reviewHold, false);
      assert.equal(row(result).classification, classification);
      assert.equal(row(result).fit.budgetFit, budgetFit);
      if (reason) assert.ok(row(result).reasons.includes(reason));
    });
  }
});

describe("data minimization and external references", () => {
  test("sanitized pronunciation and creative reference metadata never establish a transaction or delivery requirement", () => {
    const project = supported();
    for (const field of channelFields) replace(project, field);
    const references = ["pronunciation guide", "creative reference", "reference metadata"].map((label, index) =>
      observation("ref" + index, "reference", { kind: "external_reference" }, { section: label }));
    project.observations.push(...references);
    const result = normalize(project);
    for (const field of channelFields) {
      assert.equal(result.invitations[0].salazarEvidence[field], "unknown");
      assert.deepEqual(fieldOf(result, field).observationIds, []);
    }
    assert.deepEqual(first(result).observations.filter(item => item.field === "reference"), references);
    assert.equal(first(result).reviewHold, false);
    assert.equal(row(result).classification, "needs_review");
    assert.ok(!row(result).reasons.some(reason => /must occur outside Voice123/.test(reason)));
  });

  test("raw URLs outside the canonical project URL field are rejected without exposing the value", () => {
    for (const [field, url] of [
      ["description", "https://example.invalid/public-reference"],
      ["description", "https://fixture:synthetic-marker@example.invalid/resource"],
      ["excerpt", "https://example.invalid/path?token=synthetic-marker"],
      ["excerpt", "https://example.invalid/path?signature=synthetic-marker&expires=1"],
      ["excerpt", "https://example.invalid/session/synthetic-marker"],
      ["scriptText", "https://example.invalid/read-this"]
    ]) {
      const project = supported();
      const content = "Synthetic copy says " + url;
      project.observations.push(field === "excerpt" ? excerpt("sensitive", "description", content)
        : observation("sensitive", field, field === "scriptText" ? { kind: "copy", text: content } : content));
      assert.throws(() => normalize(project), error => {
        assert.equal(error.name, "ObservationInputError");
        assert.equal(error.diagnostic.code, "INVALID_INPUT");
        assert.ok(!error.message.includes(url));
        assert.ok(!JSON.stringify(error.diagnostic).includes(url));
        return true;
      });
    }
  });

  test("spoken reference phrasing remains valid recording copy without any raw URL", () => {
    const project = supported();
    removeCopyReview(project);
    const text = "Say double-you double-you double-you, then say example dot invalid.";
    replace(project, "scriptText", observation("spoken", "scriptText", { kind: "copy", text }));
    const result = normalize(project);
    assert.equal(result.invitations[0].scriptText, text);
    assert.equal(result.invitations[0].scriptAvailability, "available");
  });

  test("a bare label followed by punctuation in recording copy is not a raw URL", () => {
    const project = supported();
    removeCopyReview(project);
    const text = "Read the three letters aloud: www. Then pause for the next sentence.";
    replace(project, "scriptText", observation("letters", "scriptText", { kind: "copy", text }));
    const result = normalize(project);
    assert.equal(result.invitations[0].scriptText, text);
    assert.equal(result.invitations[0].scriptAvailability, "available");
  });
});

describe("determinism, immutability, and dependency isolation", () => {
  function freeze(value) {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }

  test("field values, holds, and conflict events are invariant to order and timestamps", () => {
    const field = "auditionChannel";
    const { whole, step, cover } = channelBuilders(field);
    const project = supported();
    replace(project, field, { ...whole("wide", "external"), observedAt: "2026-11-24T12:00:00Z" },
      step("a", "initial", "required", "voice123"), step("b", "callback", "required", "voice123"),
      cover("c", ["initial", "callback"]), cover("d", ["callback", "initial"]));
    project.determinations.push(decision("wide-review", field, "external", ["wide"], { reviewedAt: "2026-11-25T10:00:00Z" }));
    const original = normalize(project);
    assert.deepEqual(normalize(project), original);
    const reversed = clone(project);
    reversed.observations.reverse();
    reversed.observations.find(item => item.id === "wide").observedAt = "2026-11-26T05:00:00Z";
    reversed.determinations.reverse();
    reversed.determinations.find(item => item.id === "wide-review").reviewedAt = "2026-11-26T05:05:00Z";
    const changed = normalize(reversed);
    for (const result of [original, changed]) {
      assert.equal(result.invitations[0].salazarEvidence[field], "conflicting");
      assert.equal(first(result).reviewHold, true);
      assert.deepEqual(codes(result), [FC]);
      assert.equal(row(result).classification, "needs_review");
    }
    assert.deepEqual(changed.invitations, original.invitations);
    assert.deepEqual(fieldOf(original, field).observationIds, ["wide", "a", "b", "c", "d"]);
    assert.deepEqual(fieldOf(changed, field).observationIds, ["d", "c", "b", "a", "wide"]);
    assert.deepEqual(original.diagnostics[0].refs, ["wide", "a", "b", "c", "d"]);
    assert.deepEqual(changed.diagnostics[0].refs, ["d", "c", "b", "a", "wide"]);
  });

  test("reversing observation and determination chronology does not settle opposing step claims", () => {
    const field = "auditionChannel";
    const { step } = channelBuilders(field);
    const project = supported();
    replace(project, field, { ...step("a", "callback", "required", "external"), observedAt: "2026-11-24T10:00:00Z" },
      { ...step("b", "callback", "required", "voice123"), observedAt: "2026-11-25T10:00:00Z" });
    const required = { id: "callback", applicability: "required" };
    project.determinations.push(
      decision("da", field, "external", ["a"], { requirement: required, reviewedAt: "2026-11-24T11:00:00Z" }),
      decision("db", field, "voice123", ["b"], { requirement: required, reviewedAt: "2026-11-25T11:00:00Z" })
    );
    const reversed = clone(project);
    const [a, b] = reversed.observations.filter(item => item.field === field);
    [a.observedAt, b.observedAt] = [b.observedAt, a.observedAt];
    const [da, db] = reversed.determinations.filter(item => item.field === field);
    [da.reviewedAt, db.reviewedAt] = [db.reviewedAt, da.reviewedAt];
    reversed.observations.reverse();
    reversed.determinations.reverse();
    for (const item of [project, reversed]) {
      const result = normalize(item);
      assert.equal(fieldOf(result, field).value, "conflicting");
      assert.equal(first(result).reviewHold, true);
      assert.deepEqual(codes(result), [FC, CI]);
      assert.equal(row(result).classification, "needs_review");
    }
    assert.deepEqual(fieldOf(normalize(project), field).determinationIds, ["da", "db"]);
    assert.deepEqual(fieldOf(normalize(reversed), field).determinationIds, ["db", "da"]);
  });

  test("deep-frozen native input stays unchanged and independently returned structures do not alias", () => {
    const project = supported();
    addRoute(project, "v", "voice123", "required");
    const { step, cover } = channelBuilders("auditionChannel");
    replace(project, "auditionChannel", step("a", "initial", "required", "voice123", "v"),
      cover("c", ["initial"], "v"), step("o1", "copy", "optional", "external", "v"),
      step("o2", "copy", "optional", "voice123", "v"));
    const input = freeze(batch([project]));
    const snapshot = clone(input);
    const result = normalizeDiscoveryEvidence(input);
    const companion = first(result);
    result.invitations[0].budget.amount = 999;
    assert.equal(companion.fields.budget.value.amount, 250);
    companion.fields.budget.value.amount = 111;
    assert.equal(result.invitations[0].budget.amount, 999);
    const retainedBudget = companion.observations.find(item => item.field === "budget");
    assert.equal(retainedBudget.value.amount, 250);
    retainedBudget.value.amount = 222;
    companion.routes[0].observationIds.push("changed");
    companion.observations.find(item => item.id === "c").requiredIds.push("changed");
    companion.observations.find(item => item.id === "a").requirement.id = "changed";
    companion.determinations[0].observationIds.push("changed");
    result.diagnostics[0].refs.push("changed");
    assert.ok(!companion.fields.auditionChannel.observationIds.includes("changed"));
    assert.ok(!companion.fields.scriptAvailability.observationIds.includes("changed"));
    assert.deepEqual(input, snapshot);
    const fresh = normalizeDiscoveryEvidence(input);
    assert.equal(fresh.invitations[0].budget.amount, 250);
    assert.deepEqual(first(fresh).routes[0].observationIds, ["route-v"]);
    assert.deepEqual(fresh.diagnostics[0].refs, ["o1", "o2"]);
  });

  test("preview metadata is deeply detached from the frozen preview", () => {
    const input = freeze(clone(fixture.preview.input));
    const snapshot = clone(input);
    const result = normalizeDiscoveryPreview(input);
    first(result).preview.attachments[0].types.push("TXT");
    first(result).preview.rightsFlags.push("changed");
    first(result).duplicateSources.pop();
    assert.deepEqual(input, snapshot);
    const fresh = normalizeDiscoveryPreview(input);
    assert.deepEqual(first(fresh).preview.attachments[0].types, ["PDF"]);
    assert.deepEqual(first(fresh).duplicateSources, ["Local history", "Google Sheets"]);
  });

  test("restricted CommonJS realm allows offline normalization without side-effect capabilities", () => {
    const source = fs.readFileSync(require.resolve("../normalize-discovery-evidence"), "utf8");
    const context = vm.createContext({ URL, nativeJson: JSON.stringify(fixture.supported.input),
      previewJson: JSON.stringify(fixture.preview.input) },
    { codeGeneration: { strings: false, wasm: false } });
    vm.runInContext(`
      "use strict";
      globalThis.attempts = [];
      function deny(label) {
        attempts.push(label);
        throw new Error("Unexpected capability: " + label);
      }
      for (const key of ["process", "fetch", "XMLHttpRequest", "WebSocket", "navigator", "document",
        "window", "localStorage", "console", "setTimeout", "setInterval", "Buffer", "Deno", "Bun"]) {
        Object.defineProperty(globalThis, key, { get: () => deny(key) });
      }
      Object.defineProperty(Math, "random", { value: () => deny("Math.random") });
      const NativeDate = Date;
      globalThis.Date = class extends NativeDate {
        constructor(...args) {
          if (!args.length) deny("new Date()");
          super(...args);
        }
        static now() { return deny("Date.now"); }
      };
      globalThis.module = { exports: {} };
      globalThis.require = name => deny("require " + name);
    `, context);
    new vm.Script(source, { filename: "normalize-discovery-evidence.js", importModuleDynamically() {
      throw new Error("Unexpected dynamic import");
    } }).runInContext(context, { timeout: 1000 });
    const result = vm.runInContext(`
      const native = module.exports.normalizeDiscoveryEvidence(JSON.parse(nativeJson));
      const preview = module.exports.normalizeDiscoveryPreview(JSON.parse(previewJson));
      JSON.stringify({ native: native.invitations, preview: preview.batch.status,
        proposal: preview.invitations[0].proposalStatus, attempts });
    `, context, { timeout: 1000 });
    assert.deepEqual(JSON.parse(result), {
      native: [fixture.supported.expected.invitation], preview: "partial", proposal: "unknown", attempts: []
    });
  });
});

describe("actual evaluator policy and canonical caller association", () => {
  test("ranked rows join to companions by canonical identity, preserving holds and partial coverage", () => {
    const held = supported();
    held.projectId = "  bAsE1 ";
    replace(held, "title");
    const preferred = supported();
    preferred.projectId = "VOICE2";
    preferred.url = "https://voice123.com/projects/VOICE2/synthetic/specs";
    const inactive = supported();
    inactive.projectId = "VOICE3";
    inactive.url = "https://voice123.com/projects/VOICE3/synthetic/specs";
    replace(inactive, "invitationStatus", observation("inactive", "invitationStatus", "closed"));
    // Leave the preferred project with a higher fit score so ranking changes the order.
    replace(held, "description", observation("description", "description", "A regional project."));
    const result = normalizeDiscoveryEvidence(batch([held, inactive, preferred], "partial", { discovered: 9 }));
    assert.deepEqual(result.projects.map(item => item.projectId), ["BASE1", "VOICE3", "VOICE2"]);
    const ranked = evaluate(result);
    assert.deepEqual(ranked.map(item => [item.projectId, item.classification]), [
      ["VOICE2", "eligible"], ["BASE1", "eligible"], ["VOICE3", "ineligible"]
    ]);
    const byId = new Map(result.projects.map(project => [project.projectId, project]));
    for (const item of ranked) {
      const companion = byId.get(item.projectId);
      assert.equal(companion.projectId, item.projectId);
      assert.equal(companion.reviewHold, item.projectId === "BASE1");
    }
    const joinIsComplete = companions => {
      const ids = companions.filter(item => item.readStatus === "observed").map(item => item.projectId);
      const unique = new Set(ids);
      return unique.size === ids.length && ids.length === ranked.length &&
        ranked.every(item => unique.has(item.projectId));
    };
    assert.equal(joinIsComplete(result.projects), true);
    assert.equal(joinIsComplete(result.projects.slice(1)), false);
    assert.equal(joinIsComplete([...result.projects, result.projects[0]]), false);
    assert.equal(joinIsComplete([{ ...result.projects[0], projectId: "WRONG" }, ...result.projects.slice(1)]), false);
    assert.equal(result.batch.status, "partial");
    assert.equal(result.batch.discovered, 9);
  });

  test("urgent unconfirmed proposals stay unconfirmed; expired and inactive projects disqualify", () => {
    const urgent = supported();
    replace(urgent, "proposalStatus", observation("proposal", "proposalStatus", "unknown"));
    replace(urgent, "deadline", observation("deadline", "deadline", "2026-11-26T09:00:00Z"));
    const result = normalize(urgent);
    assert.equal(first(result).reviewHold, false);
    assert.deepEqual(row(result).reasons, [
      "Proposal eligibility is not confirmed",
      "Urgent: deadline is less than 24 hours away. Proposal eligibility remains unconfirmed"
    ]);
    assert.equal(row(result).classification, "needs_review");

    for (const [field, value, reason] of [
      ["deadline", "2026-11-26T05:20:00Z", "Deadline has passed"],
      ["invitationStatus", "closed", "Operator recorded an inactive invitation"],
      ["invitationStatus", "withdrawn", "Operator recorded an inactive invitation"],
      ["invitationStatus", "declined", "Operator recorded an inactive invitation"],
      ["proposalStatus", "closed", "Project is closed to proposals"]
    ]) {
      const project = supported();
      replace(project, field, observation("status", field, value));
      const ranked = row(normalize(project));
      assert.equal(ranked.classification, "ineligible");
      assert.ok(ranked.reasons.includes(reason));
    }
  });

  test("legacy modes retain their policy boundaries and reject v2-only intake", () => {
    const project = supported();
    replace(project, "budget", observation("small", "budget", { amount: 50, currency: "USD" }));
    const result = normalize(project);
    const [v2] = result.invitations;
    const { salazarEvidence, ...legacy } = v2;
    assert.deepEqual(salazarEvidence, fixture.supported.expected.invitation.salazarEvidence);
    assert.equal(evaluateOpportunities([legacy], preferences, now).opportunities[0].classification, "eligible");
    assert.equal(evaluateOpportunities([legacy], preferences, now, { salazarPolicyV1: true })
      .opportunities[0].classification, "needs_review");
    assert.equal(row(result).classification, "needs_review");
    assert.equal(evaluateOpportunities([legacy], preferences, now, policy).opportunities[0].classification, "needs_review");
    for (const options of [{}, { salazarPolicyV1: true }]) {
      assert.throws(() => evaluateOpportunities([v2], preferences, now, options), /unexpected field/);
    }
    assert.throws(() => evaluateOpportunities([v2], preferences, now,
      { salazarPolicyV1: true, salazarPolicyV2: true }), /mutually exclusive/);
  });
});
