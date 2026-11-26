const { assessSharedSalazarPolicy, minimumLeadTime } = require("./salazar-media-policy");

const mandatoryEvidence = [
  ["scriptLanguage", "Recording language", ["non_english", "mixed"], "Required recording material includes non-English copy"],
  ["paymentChannel", "Payment channel", ["external"], "Payment must occur outside Voice123"],
  ["paymentSecurity", "Payment security", ["unsecured"], "Payment is unsecured"],
  ["paymentTerms", "Payment terms", ["nonstandard"], "Payment terms are not standard Voice123 secured payment terms"],
  ["auditionChannel", "Audition channel", ["external"], "Audition submission must occur outside Voice123"],
  ["communicationChannel", "Communication channel", ["external"], "Project communications must occur outside Voice123"],
  ["transactionChannel", "Transaction channel", ["external"], "Business transactions must occur outside Voice123"]
];

function assessSalazarPolicyV2(project, preferences, now) {
  const assessment = assessSharedSalazarPolicy(project, preferences);
  const { ineligible, review, warnings } = assessment;
  const evidence = project.salazarEvidence;
  const overlappingExternalChannels = evidence.paymentChannel === "external" && evidence.transactionChannel === "external";

  if (project.budget === null) review.push("Compensation amount is unreported");
  for (const [field, label, violations, reason] of mandatoryEvidence) {
    const value = evidence[field];
    if (value === "unknown") {
      review.push(label + " is unconfirmed");
    } else if (value === "conflicting") {
      review.push(label + " evidence conflicts");
    } else if (violations.includes(value)) {
      if (overlappingExternalChannels && field === "transactionChannel") continue;
      ineligible.push(overlappingExternalChannels && field === "paymentChannel"
        ? "Payment and business transactions must occur outside Voice123"
        : reason);
    }
  }

  if (project.deadline !== null && ["new", "revision_requested", "unknown"].includes(project.invitationStatus) &&
      ["open", "unknown"].includes(project.proposalStatus)) {
    const leadTime = project.deadline - now;
    if (leadTime > 0 && leadTime < minimumLeadTime) {
      warnings.push(project.proposalStatus === "unknown"
        ? "Urgent: deadline is less than 24 hours away. Proposal eligibility remains unconfirmed"
        : "Urgent: open proposal deadline is less than 24 hours away");
    }
  }
  return assessment;
}

module.exports = { assessSalazarPolicyV2 };
