const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { evaluateOpportunities } = require("../evaluate-opportunities");
const invitations = require("./fixtures/offline-invitations.json");
const preferences = require("./fixtures/offline-preferences.json");

const now = Date.parse("2099-05-18T00:00:00Z");
const [eligible, needsReview, closed] = invitations;
const evaluate = (cases, settings) => evaluateOpportunities(cases, settings, now).opportunities;

test("ranks eligibility ahead of fit and explains each classification", () => {
  const shortlist = evaluate([closed, needsReview, eligible], preferences);
  assert.deepEqual(shortlist.map(row => [row.rank, row.projectId, row.classification]), [
    [1, eligible.projectId, "eligible"], [2, needsReview.projectId, "needs_review"], [3, closed.projectId, "ineligible"]
  ]);
  assert.equal(shortlist[0].fit.score, 6);
  assert.equal(shortlist[0].deadline, "2099-05-20T21:00:00.000Z");
  assert.match(shortlist[1].reasons.join(" "), /attachments.*usability.*rights/i);
  assert.ok(shortlist[2].reasons.includes("Project is closed to proposals"));
});

test("keeps unreported project evidence distinct from confirmed ineligibility", () => {
  const [unknown] = evaluate([{ projectId: "MISSING", title: "Missing evidence" }]);
  assert.equal(unknown.classification, "needs_review");
  assert.ok(unknown.reasons.includes("Proposal eligibility is not confirmed"));
  assert.ok(unknown.reasons.includes("Deadline is unconfirmed"));
  assert.equal(unknown.fit.budgetFit, "budget_unreported");
  const [expired] = evaluate([{ ...eligible, deadline: "2099-05-18T00:00:00Z" }]);
  assert.equal(expired.classification, "ineligible");
  assert.ok(expired.reasons.includes("Deadline has passed"));
  const [revision] = evaluate([{ ...eligible, invitationStatus: "revision_requested" }]);
  assert.equal(revision.classification, "needs_review");
  assert.ok(revision.reasons.includes("Revision request requires manual review"));
});

test("applies the shared script-content heuristic without emitting supplied copy", () => {
  const scriptText = "Please submit a demo based on these instructions. This is long enough to resemble recording copy.";
  const realCopy = "On the far side of the harbor, the lanterns cast a warm glow over the little wooden boats.";
  const rows = evaluate([
    { ...eligible, projectId: "INSTRUCTIONS", scriptText },
    { ...eligible, projectId: "COPY", scriptText: realCopy },
    { ...eligible, projectId: "UNREVIEWED", scriptAvailability: "available", scriptText: realCopy }
  ]);
  assert.deepEqual(rows.map(row => [row.projectId, row.classification]), [
    ["COPY", "eligible"], ["INSTRUCTIONS", "needs_review"], ["UNREVIEWED", "needs_review"]
  ]);
  assert.ok(!JSON.stringify(rows).includes(scriptText));
  assert.ok(!JSON.stringify(rows).includes(realCopy));
});

test("ranks by preferences within a class, keeps currencies separate and breaks ties deterministically", () => {
  const versions = [
    { ...eligible, projectId: "C", title: "Earlier", deadline: "2099-05-19T00:00Z", budget: { amount: 700, currency: "CAD" } },
    { ...eligible, projectId: "B", title: "Medical", budget: { amount: 300, currency: "USD" } },
    { ...eligible, projectId: "A", title: "Medical", budget: { amount: 300, currency: "USD" } }
  ];
  const result = evaluate(versions, { preferredTerms: ["medical", "MEDICAL"], budgetTargets: { USD: 400 } });
  assert.deepEqual(result.map(row => row.projectId), ["C", "A", "B"]);
  assert.equal(result[0].fit.budgetFit, "no_target_for_currency");
  assert.equal(result[1].fit.budgetFit, "below_target");
  assert.deepEqual(result[1].fit.preferredMatches, ["medical"]);
  assert.equal(evaluate(versions, { preferredTerms: ["medical"] })[0].projectId, "A");
  assert.equal(evaluateOpportunities(versions, {}, now).preferencesConfigured, false);
});

test("rejects malformed intake, invalid deadlines and duplicate IDs", () => {
  for (const deadline of ["2099-05-20", "2099-05-20T12:00", "2099-02-29T12:00Z"]) {
    assert.throws(() => evaluate([{ ...eligible, deadline }]), /explicit timezone/);
  }
  assert.throws(() => evaluate([{ ...eligible, proposalStatus: "maybe" }]), /unsupported status/);
  assert.throws(() => evaluate([{ ...eligible, budget: { amount: -1, currency: "USD" } }]), /nonnegative/);
  assert.throws(() => evaluate([eligible, { ...eligible, projectId: eligible.projectId.toLowerCase() }]), /Duplicate/);
  assert.throws(() => evaluate([], { preferredTerms: ["narration"], avoidTerms: ["NARRATION"] }), /both preference lists/);
});

test("CLI runs with an empty environment and reads fixture files only", () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, "../evaluate-opportunities.js"), ...args],
    { encoding: "utf8", env: {} });
  const report = run(path.join(__dirname, "fixtures/offline-invitations.json"),
    path.join(__dirname, "fixtures/offline-preferences.json"));
  assert.equal(report.status, 0);
  assert.equal(report.stderr, "");
  assert.equal(JSON.parse(report.stdout).opportunities[0].projectId, eligible.projectId);
  const invalid = run("https://example.invalid/private-token");
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /local JSON/);
  assert.doesNotMatch(invalid.stderr, /private-token/);
});

const salazarPreferences = require("../salazar-media-preferences.json");
const applySalazar = (changes, settings = salazarPreferences) =>
  evaluateOpportunities([{ ...eligible, title: "Synthetic voice role", ...changes }],
    settings, now, { salazarPolicyV1: true }).opportunities[0];

test("Salazar policy disqualifies confirmed unpaid work and puts decisive reasons first", () => {
  for (const description of ["This is unpaid work.", "This is a volunteer project.", "Budget: $0.00.",
    "No compensation is offered."]) {
    const row = applySalazar({ description, budget: null, rightsStatus: "unknown" });
    assert.equal(row.classification, "ineligible");
    assert.match(row.reasons[0], /^Confirmed unpaid work/);
    assert.ok(row.reasons.includes("Voice rights and usage terms are unconfirmed"));
  }
});

test("Salazar policy distinguishes negation, ambiguous risk wording, and conflicting evidence", () => {
  const negated = applySalazar({ description: "This is not unpaid work.", budget: null });
  assert.equal(negated.classification, "eligible");
  assert.deepEqual(negated.fit.avoidMatches, []);
  assert.equal(negated.fit.budgetFit, "budget_unreported");
  const ambiguous = applySalazar({
    description: "We previously considered volunteer work. The payment is TBD; it might be just for fun.",
    budget: null
  });
  assert.equal(ambiguous.classification, "eligible");
  assert.deepEqual(ambiguous.fit.avoidMatches, ["volunteer work", "just for fun"]);
  assert.ok(ambiguous.reasons.some(reason => reason.includes("Business-risk")));
  assert.equal(ambiguous.fit.budgetFit, "budget_unreported");
  const conditional = applySalazar({ description: "If this is unpaid work, we will revise the scope.", budget: null });
  assert.equal(conditional.classification, "eligible");
  const titleOnly = applySalazar({ title: "Volunteer work", description: "Read an essay about helping others.", budget: null });
  assert.equal(titleOnly.classification, "eligible");
  const conflict = applySalazar({ description: "This project is unpaid.", budget: { amount: 150, currency: "USD" } });
  assert.equal(conflict.classification, "needs_review");
  assert.equal(conflict.fit.score, 0);
  assert.match(conflict.reasons.join(" "), /evidence conflicts/);
});

test("Salazar USD budget thresholds preserve existing eligibility checks", () => {
  for (const [amount, classification, budgetFit, score] of [
    [0, "ineligible", "below_target", -2],
    [50, "needs_review", "below_target", -2],
    [100, "eligible", "meets_target", 2],
    [150, "eligible", "meets_target", 2]
  ]) {
    const row = applySalazar({ description: "Record a short synthetic voice piece.", budget: { amount, currency: "USD" } });
    assert.equal(row.classification, classification);
    assert.equal(row.fit.budgetFit, budgetFit);
    assert.equal(row.fit.score, score);
    if (amount === 50) assert.ok(row.reasons.some(reason => reason.includes("preferred target of $100")));
  }
  const closedLowBudget = applySalazar({ proposalStatus: "closed", budget: { amount: 50, currency: "USD" } });
  assert.equal(closedLowBudget.classification, "ineligible");
  assert.equal(closedLowBudget.reasons[0], "Project is closed to proposals");
  assert.ok(closedLowBudget.reasons.some(reason => reason.includes("preferred target of $100")));
  assert.equal(applySalazar({ scriptAvailability: "missing", budget: { amount: 150, currency: "USD" } }).classification, "needs_review");
  assert.equal(applySalazar({ budget: { amount: 50, currency: "CAD" } }).classification, "eligible");
  assert.equal(applySalazar({ budget: null }).fit.budgetFit, "budget_unreported");
});

test("Salazar lead time is timezone-aware and urgency does not affect eligibility", () => {
  const urgent = row => row.reasons.some(reason => reason.startsWith("Urgent:"));
  for (const [deadline, expectedClassification, expectedUrgency] of [
    ["2099-05-17T18:59:59-05:00", "ineligible", false],
    ["2099-05-18T18:59:59-05:00", "eligible", true],
    ["2099-05-18T19:00:00-05:00", "eligible", false],
    ["2099-05-18T19:00:01-05:00", "eligible", false],
    [null, "needs_review", false]
  ]) {
    const row = applySalazar({ deadline });
    assert.equal(row.classification, expectedClassification);
    assert.equal(urgent(row), expectedUrgency);
  }
  assert.equal(urgent(applySalazar({ deadline: "2099-05-18T01:00Z", proposalStatus: "closed" })), false);
});

test("Salazar category synonyms earn a single score per category", () => {
  const description = "A narrator for narration in commercials, a corporate explainer, an elearning and e-learning course, and an audio book and audiobook.";
  const row = applySalazar({ description, budget: null }, {
    ...salazarPreferences,
    preferredTerms: [...salazarPreferences.preferredTerms, "narrator", "explainer", "elearning", "audio book"]
  });
  assert.deepEqual(row.fit.preferredMatches, salazarPreferences.preferredTerms);
  assert.equal(row.fit.score, 10);
  const outOfFit = applySalazar({ description: "Record a synthetic voice piece.", budget: null });
  assert.equal(outOfFit.classification, "eligible");
  assert.equal(outOfFit.fit.score, 0);
});

test("Salazar configuration preserves JSON shape and legacy scoring when the policy is omitted", () => {
  const project = { ...eligible, deadline: "2099-05-18T01:00Z", budget: { amount: 50, currency: "USD" } };
  const [baseline] = evaluate([project], salazarPreferences);
  const policy = applySalazar(project);
  assert.equal(baseline.classification, "eligible");
  assert.equal(policy.classification, "needs_review");
  assert.deepEqual(Object.keys(policy), Object.keys(baseline));
  assert.deepEqual(Object.keys(policy.fit), Object.keys(baseline.fit));
  const result = spawnSync(process.execPath, [path.join(__dirname, "../evaluate-opportunities.js"),
    "--salazar-policy-v1", path.join(__dirname, "fixtures/offline-invitations.json"),
    path.join(__dirname, "../salazar-media-preferences.json")], { encoding: "utf8", env: {} });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.ok(JSON.parse(result.stdout).preferencesConfigured);
});
