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

test("Salazar v1 keeps compensation, budget, risk and urgency reasons in order", () => {
  const project = {
    description: "This is unpaid work.",
    budget: { amount: 50, currency: "USD" },
    deadline: "2099-05-18T01:00Z"
  };
  const sharedReasons = [
    "Compensation evidence conflicts; confirm whether the work is paid",
    "Reported USD budget is below the preferred target of $100",
    "Business-risk wording matched; verify the context before deciding"
  ];
  const open = applySalazar(project);
  assert.equal(open.classification, "needs_review");
  assert.deepEqual(open.reasons, [
    ...sharedReasons, "Urgent: open proposal deadline is less than 24 hours away"
  ]);
  const unknown = applySalazar({ ...project, proposalStatus: "unknown" });
  assert.equal(unknown.classification, "needs_review");
  assert.deepEqual(unknown.reasons, ["Proposal eligibility is not confirmed", ...sharedReasons]);
  assert.deepEqual(unknown.fit, open.fit);
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

const evaluateV2 = cases => evaluateOpportunities(cases, salazarPreferences, now, { salazarPolicyV2: true });
const compliantEvidence = {
  scriptLanguage: "english", paymentChannel: "voice123", paymentSecurity: "secured",
  paymentTerms: "platform_standard", auditionChannel: "voice123",
  communicationChannel: "voice123", transactionChannel: "voice123"
};
const applyV2 = (changes = {}, evidence = {}) =>
  evaluateV2([{ ...eligible, ...changes, salazarEvidence: { ...compliantEvidence, ...evidence } }]).opportunities[0];

test("Policy v2 reviews legacy invitations and distinguishes unknown and conflicting evidence", () => {
  const withEveryField = value => Object.fromEntries(Object.keys(compliantEvidence).map(field => [field, value]));
  const legacy = evaluateV2([eligible]).opportunities[0];
  assert.equal(legacy.classification, "needs_review");
  assert.equal(legacy.reasons.length, 7);
  assert.ok(legacy.reasons.every(reason => reason.endsWith("is unconfirmed")));
  for (const salazarEvidence of [
    {}, null, withEveryField(null), withEveryField("unknown")
  ]) {
    assert.deepEqual(evaluateV2([{ ...eligible, salazarEvidence }]).opportunities[0], legacy);
  }
  const conflicting = applyV2({}, withEveryField("conflicting"));
  assert.equal(conflicting.classification, "needs_review");
  assert.deepEqual(conflicting.reasons, legacy.reasons.map(reason => reason.replace("is unconfirmed", "evidence conflicts")));
  assert.equal(evaluateV2(invitations).opportunities.length, invitations.length);
  assert.deepEqual(evaluateV2([]).opportunities, []);
});

test("Policy v2 trusts structured recording evidence and allows external references", () => {
  const row = applyV2({ description: "Locución para un museo. Referencias en https://example.invalid/video." });
  assert.equal(row.classification, "eligible");
  assert.equal(applyV2({ description: "Record this museum narration." }, {
    scriptLanguage: "non_english"
  }).classification, "ineligible");
});

const mandatoryViolations = [
  ["scriptLanguage", "non_english", "Required recording material includes non-English copy"],
  ["scriptLanguage", "mixed", "Required recording material includes non-English copy"],
  ["paymentChannel", "external", "Payment must occur outside Voice123"],
  ["paymentSecurity", "unsecured", "Payment is unsecured"],
  ["paymentTerms", "nonstandard", "Payment terms are not standard Voice123 secured payment terms"],
  ["auditionChannel", "external", "Audition submission must occur outside Voice123"],
  ["communicationChannel", "external", "Project communications must occur outside Voice123"],
  ["transactionChannel", "external", "Business transactions must occur outside Voice123"]
];

test("Each Policy v2 mandatory violation disqualifies independently despite high pay and fit", () => {
  const project = {
    description: "Narration for commercials, explainers, e-learning and audiobooks.",
    budget: { amount: 2000, currency: "USD" }
  };
  for (const [field, value, reason] of mandatoryViolations) {
    const row = applyV2(project, { [field]: value });
    assert.equal(row.classification, "ineligible", field);
    assert.deepEqual(row.reasons, [reason]);
    assert.equal(row.fit.score, 12);
    assert.equal(row.fit.budgetFit, "meets_target");
  }
});

test("Policy v2 reuses compensation rules and reviews unreported compensation", () => {
  for (const [amount, description, classification, reasons] of [
    [0, "Record a synthetic narration.", "ineligible", ["Confirmed unpaid work: reported budget is zero"]],
    [null, "This is a volunteer project.", "ineligible", [
      "Confirmed unpaid work: the invitation explicitly states unpaid or volunteer compensation terms",
      "Compensation amount is unreported"
    ]],
    [null, "Record a synthetic narration.", "needs_review", ["Compensation amount is unreported"]],
    [2000, "This is unpaid work.", "needs_review", [
      "Compensation evidence conflicts; confirm whether the work is paid",
      "Business-risk wording matched; verify the context before deciding"
    ]],
    [99, "Record a synthetic narration.", "needs_review", ["Reported USD budget is below the preferred target of $100"]],
    [100, "Record a synthetic narration.", "eligible", ["Supplied evidence supports an open invitation with usable audition material"]]
  ]) {
    const budget = amount === null ? null : { amount, currency: "USD" };
    const row = applyV2({ budget, description });
    assert.equal(row.classification, classification);
    assert.deepEqual(row.reasons, reasons);
  }
});

test("Policy v2 aggregates disqualifications, review reasons and warnings in order", () => {
  const row = applyV2({
    proposalStatus: "unknown", deadline: "2099-05-18T01:00Z",
    attachmentRequirements: "required", scriptAvailability: "available", rightsStatus: "review_required"
  }, {
    scriptLanguage: "mixed", paymentChannel: "external", paymentSecurity: "unsecured",
    paymentTerms: "nonstandard", auditionChannel: "external", communicationChannel: "conflicting",
    transactionChannel: "external"
  });
  assert.equal(row.classification, "ineligible");
  assert.deepEqual(row.reasons, [
    "Required recording material includes non-English copy",
    "Payment and business transactions must occur outside Voice123",
    "Payment is unsecured",
    "Payment terms are not standard Voice123 secured payment terms",
    "Audition submission must occur outside Voice123",
    "Proposal eligibility is not confirmed",
    "Required attachments need manual review",
    "Audition script is listed as available but its usability is unconfirmed",
    "Voice rights or usage terms need manual review",
    "Communication channel evidence conflicts",
    "Urgent: deadline is less than 24 hours away. Proposal eligibility remains unconfirmed"
  ]);
  const closed = applyV2({ proposalStatus: "closed", deadline: "2099-05-17T23:59Z" });
  assert.equal(closed.classification, "ineligible");
  assert.deepEqual(closed.reasons, ["Project is closed to proposals", "Deadline has passed"]);
});

test("Policy v2 urgency honors strict boundaries and invitation and proposal statuses", () => {
  const urgent = row => row.reasons.some(reason => reason.startsWith("Urgent:"));
  for (const [deadline, classification, warning] of [
    ["2099-05-18T18:59:59-05:00", "eligible", true],
    ["2099-05-18T19:00:00-05:00", "eligible", false],
    ["2099-05-18T00:00:00Z", "ineligible", false],
    ["2099-05-17T23:59:59Z", "ineligible", false],
    [null, "needs_review", false]
  ]) {
    const row = applyV2({ deadline });
    assert.equal(row.classification, classification);
    assert.equal(urgent(row), warning);
  }
  for (const invitationStatus of ["new", "revision_requested", "unknown", "closed", "withdrawn", "declined"]) {
    for (const proposalStatus of ["open", "unknown", "closed"]) {
      const statuses = { invitationStatus, proposalStatus };
      const shortWindow = applyV2({ ...statuses, deadline: "2099-05-18T01:00Z" });
      const longWindow = applyV2({ ...statuses, deadline: "2099-05-19T00:00Z" });
      const potentiallyActive = ["new", "revision_requested", "unknown"].includes(invitationStatus);
      assert.equal(urgent(shortWindow), potentiallyActive && proposalStatus !== "closed");
      assert.equal(shortWindow.classification, longWindow.classification);
      assert.deepEqual(shortWindow.reasons.filter(reason => !reason.startsWith("Urgent:")), longWindow.reasons);
    }
  }
});

test("Policy v2 rejects invalid evidence across the entire intake", () => {
  for (const salazarEvidence of [[], "", false, 1]) {
    assert.throws(() => evaluateV2([{ ...eligible, salazarEvidence }]), /salazarEvidence must be an object/);
  }
  assert.throws(() => evaluateV2([{ ...eligible, salazarEvidence: { typo: "unknown" } }]),
    /salazarEvidence contains an unexpected field/);

  for (const [field, invalid] of Object.entries({
    scriptLanguage: "English", paymentChannel: "paypal", paymentSecurity: true,
    paymentTerms: 45, auditionChannel: [], communicationChannel: {}, transactionChannel: "secured"
  })) {
    const invalidInvitation = { ...needsReview, salazarEvidence: { [field]: invalid } };
    assert.throws(() => evaluateV2([eligible, invalidInvitation]), {
      message: "Invitation 2 salazarEvidence." + field + " has an unsupported status"
    });
  }
});

test("Policy v2 rejects inherited invitation, evidence and compensation fields", () => {
  const project = { ...eligible, salazarEvidence: compliantEvidence };
  const inheritedEvidence = Object.create(compliantEvidence);
  assert.deepEqual(Object.keys(inheritedEvidence), []);
  for (const [invitation, label] of [
    [{ ...project, salazarEvidence: inheritedEvidence }, "salazarEvidence"],
    [{ ...project, salazarEvidence: Object.assign(Object.create(compliantEvidence), { scriptLanguage: "english" }) },
      "salazarEvidence"],
    [Object.assign(Object.create({ salazarEvidence: compliantEvidence }), eligible), "Invitation 1"],
    [{ ...project, budget: Object.create(project.budget) }, "budget"]
  ]) {
    assert.throws(() => evaluateV2([invitation]), new RegExp(label + " must be a plain data object"));
  }
});

test("Policy v2 only accepts enumerable own data properties without invoking accessors", () => {
  for (const [field, key, data] of [
    [null, "title", { ...eligible, salazarEvidence: compliantEvidence }],
    ["salazarEvidence", "scriptLanguage", compliantEvidence],
    ["budget", "amount", eligible.budget]
  ]) {
    const withObject = object => field
      ? { ...eligible, salazarEvidence: compliantEvidence, [field]: object }
      : object;
    let accessorCalls = 0;
    for (const [property, descriptor] of [
      [key, { enumerable: true, get() { accessorCalls++; return data[key]; } }],
      [key, { enumerable: true, set(_) { accessorCalls++; } }],
      [key, { enumerable: false, value: data[key] }],
      [Symbol("unexpected"), { enumerable: true, value: "unexpected" }]
    ]) {
      const object = Object.defineProperty({ ...data }, property, descriptor);
      assert.throws(() => evaluateV2([withObject(object)]), /must contain only enumerable string-keyed data properties/);
    }
    assert.equal(accessorCalls, 0);
  }
});

test("Policy v2 accepts null-prototype data objects and reviews empty evidence", () => {
  const ownData = value => Object.assign(Object.create(null), value);
  const invitation = ownData({
    ...eligible, budget: ownData(eligible.budget), salazarEvidence: ownData(compliantEvidence)
  });
  assert.deepEqual(evaluateV2([invitation]).opportunities[0], applyV2());
  assert.equal(applyV2().classification, "eligible");
  assert.equal(evaluateV2([{ ...eligible, salazarEvidence: {} }]).opportunities[0].classification, "needs_review");
});

test("default and Policy v1 keep legacy results and reject Policy v2 evidence", () => {
  const project = { ...eligible, budget: { amount: 50, currency: "USD" } };
  for (const [options, classification] of [
    [{}, "eligible"], [{ salazarPolicyV1: true }, "needs_review"]
  ]) {
    const evaluateWithPolicy = cases => evaluateOpportunities(cases, salazarPreferences, now, options);
    assert.equal(evaluateWithPolicy([project]).opportunities[0].classification, classification);
    assert.throws(() => evaluateWithPolicy([{ ...project, salazarEvidence: null }]), /unexpected field/);
  }
});

test("Policy selection rejects simultaneous versions through the API and CLI", () => {
  assert.throws(() => evaluateOpportunities(invitations, salazarPreferences, now, {
    salazarPolicyV1: true, salazarPolicyV2: true
  }), /mutually exclusive/);

  const fixture = path.join(__dirname, "fixtures/offline-invitations.json");
  const settings = path.join(__dirname, "../salazar-media-preferences.json");
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, "../evaluate-opportunities.js"), ...args],
    { encoding: "utf8", env: {} });
  const v2 = run("--salazar-policy-v2", fixture, settings);
  assert.equal(v2.status, 0);
  assert.equal(v2.stderr, "");
  const report = JSON.parse(v2.stdout);
  assert.deepEqual(report,
    evaluateOpportunities(invitations, salazarPreferences, Date.parse(report.evaluatedAt), { salazarPolicyV2: true }));
  assert.equal(report.opportunities.find(row => row.projectId === eligible.projectId).classification, "needs_review");

  const missingPreferences = run("--salazar-policy-v2", fixture);
  assert.equal(missingPreferences.status, 1);
  assert.equal(missingPreferences.stdout, "");
  assert.match(missingPreferences.stderr, /Usage:/);

  const ambiguous = run("--salazar-policy-v1", "--salazar-policy-v2", fixture, settings);
  assert.equal(ambiguous.status, 1);
  assert.equal(ambiguous.stdout, "");
  assert.match(ambiguous.stderr, /mutually exclusive/);
});

test("Colgate reproduces the Policy v1 baseline and is ineligible under Policy v2", () => {
  // Operator-supplied English summary and evidence. The CST offset is provisional.
  const invitation = {
    projectId: "IO0BMO0L0",
    title: "Colgate – Nativos Colombia o Mexico",
    deadline: "2026-11-26T13:09:00-06:00",
    budget: {
      amount: 2000,
      currency: "USD"
    },
    description: "Commercial campaign for Colgate, produced by Yeti Sounds in São Paulo, Brazil. Voice requirements: Spanish - Latin American Neutral, male adult. Native speaker of Colombia or Mexico is mandatory. Fixed budget USD 2000. Project not secured; client has not yet secured payment. Payment must be made directly by Yeti Sounds through PayPal, outside Voice123, within 45 days after final recording. Custom audition must be sent by external email, confirming acceptance of the campaign conditions. All subsequent communications must take place by email. Campaign includes three 15-second TV spots, three 10-second TV spots, three 5-second TV spots, and five digital pieces of up to 12 seconds. Territory: LATAM. Paid media usage: 18 months. Recording length: 150 seconds. Google Drive animatic and YouTube pronunciation references provided. Custom audition portfolio usage permitted. Number of proposals wanted: 30.",
    scriptText: "V.O: Tu cena sigue ahí... ...Y ella lo nota. Cepillate después de la cena. Colgate.",
    scriptAvailability: "verified_usable",
    attachmentRequirements: "unknown",
    invitationStatus: "new",
    proposalStatus: "unknown",
    rightsStatus: "review_required",
    salazarEvidence: {
      scriptLanguage: "non_english",
      paymentChannel: "external",
      paymentSecurity: "unsecured",
      paymentTerms: "nonstandard",
      auditionChannel: "external",
      communicationChannel: "external",
      transactionChannel: "external"
    }
  };
  const { salazarEvidence, ...legacyInvitation } = invitation;
  const evaluatedAt = "2026-11-26T05:20:00.000Z";
  const evaluationTime = Date.parse(evaluatedAt);
  const deadline = "2026-11-26T19:09:00.000Z";
  assert.equal(Date.parse(deadline) - evaluationTime, (13 * 60 + 49) * 60 * 1000);

  const expected = {
    rank: 1, projectId: "IO0BMO0L0", title: "Colgate – Nativos Colombia o Mexico", deadline,
    budget: { amount: 2000, currency: "USD" },
    fit: { score: 4, preferredMatches: ["commercials"], avoidMatches: [], budgetFit: "meets_target" }
  };
  const reviewReasons = [
    "Proposal eligibility is not confirmed",
    "Attachment requirements are unconfirmed",
    "Voice rights or usage terms need manual review"
  ];
  const policyV1 = evaluateOpportunities([legacyInvitation], salazarPreferences, evaluationTime, { salazarPolicyV1: true });
  assert.deepEqual(policyV1, {
    evaluatedAt, preferencesConfigured: true,
    opportunities: [{ ...expected, classification: "needs_review", reasons: reviewReasons }]
  });

  const policyV2 = evaluateOpportunities([invitation], salazarPreferences, evaluationTime, { salazarPolicyV2: true });
  assert.deepEqual(policyV2, {
    evaluatedAt, preferencesConfigured: true,
    opportunities: [{
      ...expected, classification: "ineligible", reasons: [
        "Required recording material includes non-English copy",
        "Payment and business transactions must occur outside Voice123",
        "Payment is unsecured",
        "Payment terms are not standard Voice123 secured payment terms",
        "Audition submission must occur outside Voice123",
        "Project communications must occur outside Voice123",
        ...reviewReasons,
        "Urgent: deadline is less than 24 hours away. Proposal eligibility remains unconfirmed"
      ]
    }]
  });
});
