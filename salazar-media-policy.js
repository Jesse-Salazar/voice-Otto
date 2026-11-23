const minimumLeadTime = 24 * 60 * 60 * 1000;
const inactiveInvitations = ["closed", "withdrawn", "declined"];
const categoryAliases = new Map([
  ["narration", ["narration", "narrator"]],
  ["commercials", ["commercial", "commercials"]],
  ["corporate / explainer", ["corporate", "explainer", "explainers"]],
  ["e-learning", ["e-learning", "e learning", "elearning"]],
  ["audiobooks", ["audiobook", "audiobooks", "audio book", "audio books"]]
]);

function phrasePattern(phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(String.raw`\b${escaped}\b`, "g");
}

function preferredCategoryMatches(text, terms) {
  const matches = new Set();
  for (const term of terms) {
    const category = [...categoryAliases].find(([name, aliases]) => name === term || aliases.includes(term));
    if (!category) {
      if (text.includes(term)) matches.add(term);
    } else if (category[1].some(alias => phrasePattern(alias).test(text))) {
      matches.add(category[0]);
    }
  }
  return [...matches];
}

const unpaidStatement = /^(?:(?:(?:this is|(?:this|the) (?:project|role|work|opportunity) is|we are offering) (?:an? )?|(?:compensation|payment)\s*:\s*)(?:explicitly )?(?:unpaid(?: (?:work|project|role|opportunity|voice[ -]?over))?|volunteer (?:work|project|role|opportunity)))$/;
const zeroCompensation = /^(?:(?:the )?(?:voice[ -]?over )?(?:budget|compensation|payment)(?:\s*[:=]\s*| is )(?:zero|(?:usd\s*)?\$?0(?:\.0{1,2})?(?:\s+usd)?)|(?:there is )?no (?:pay|payment|compensation)(?: (?:is )?(?:offered|provided|available|for this (?:project|role)))?)$/;
const paidStatement = /^(?:(?:this is|(?:this|the) (?:project|role|work|opportunity) is) )?(?:an? )?paid(?: (?:project|role|work|opportunity))?$/;

function compensationClauses(text) {
  return text.toLowerCase().split(/[.!?](?:\s+|$)|\r?\n|;/).map(clause => clause.trim());
}

function termEvidence(clauses, term) {
  let affirmed = false;
  let negated = false;
  for (const clause of clauses) {
    for (const match of clause.matchAll(phrasePattern(term))) {
      const before = clause.slice(0, match.index);
      const after = clause.slice(match.index + term.length);
      if (/\b(?:not|never|no)\s+(?:(?:an?|the|doing|seeking|accepting|offering)\s+)*$/.test(before) ||
          /^\s+(?:(?:is|was|will be|are)\s+)?(?:not|never)\b/.test(after)) {
        negated = true;
      } else {
        affirmed = true;
      }
    }
  }
  return { affirmed, negated };
}

function assessSalazarPolicy(project, preferences, now) {
  const descriptionClauses = compensationClauses(project.description ?? "");
  const clauses = [...compensationClauses(project.title), ...descriptionClauses];
  const text = (project.title + " " + (project.description ?? "")).toLowerCase().replace(/[‐‑–—]/g, "-");
  const avoidMatches = preferences.avoidTerms.filter(term => termEvidence(clauses, term).affirmed);
  const ineligible = [];
  const review = [];
  const warnings = [];
  const reportedAmount = project.budget?.amount;
  const explicitUnpaid = descriptionClauses.some(clause => unpaidStatement.test(clause) || zeroCompensation.test(clause));
  const conflictingPayEvidence = reportedAmount > 0 || descriptionClauses.some(clause => paidStatement.test(clause)) ||
    ["unpaid", "volunteer work", "zero budget"].some(term => termEvidence(clauses, term).negated);
  const compensationConflict = explicitUnpaid && conflictingPayEvidence && reportedAmount !== 0;

  if (reportedAmount === 0) {
    ineligible.push("Confirmed unpaid work: reported budget is zero");
  } else if (compensationConflict) {
    review.push("Compensation evidence conflicts; confirm whether the work is paid");
  } else if (explicitUnpaid) {
    ineligible.push("Confirmed unpaid work: the invitation explicitly states unpaid or volunteer compensation terms");
  }

  const usdTarget = preferences.budgetTargets.get("USD");
  if (project.budget?.currency === "USD" && reportedAmount > 0 && reportedAmount < usdTarget) {
    review.push("Reported USD budget is below the preferred target of $" + usdTarget);
  }
  if (avoidMatches.length) warnings.push("Business-risk wording matched; verify the context before deciding");
  const leadTime = project.deadline === null ? null : project.deadline - now;
  if (project.proposalStatus === "open" && !inactiveInvitations.includes(project.invitationStatus) &&
      leadTime > 0 && leadTime < minimumLeadTime) {
    warnings.push("Urgent: open proposal deadline is less than 24 hours away");
  }

  return {
    ineligible, review, warnings, avoidMatches, compensationConflict,
    preferredMatches: preferredCategoryMatches(text, preferences.preferredTerms)
  };
}

module.exports = { assessSalazarPolicy };
