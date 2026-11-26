# Production authorization and recovery

Keep dry-run active and paid generation and submission disabled by default.
Shell overrides are effective when the application loads the environment file.
The following table documents required conditions for supported entry points.
A setting that enables an operation does not authorize using it.

| Entry point | Required conditions and effects |
| --- | --- |
| `npm run evaluate -- <invitations.json> [preferences.json]` | Reads operator-supplied local JSON and prints a ranked shortlist. No browser, credentials, network access, or production state are needed. |
| `node connectivity-check.js` | Dry-run with generation and submission disabled. Only the scoped read-only probes. |
| `node main.js` or `checkInvites()` | Default dry-run reads and previews. Exact `DRY_RUN=false` and one discovery permit allow locking and persisting that one project to Sheets and local history. This holds even when both provider switches are disabled. Explicit `checkInvites({dryRun:false})` cannot override dry-run. |
| `generateAudio(id, script)` or generation via `node main.js` | Exact `DRY_RUN=false` and `ENABLE_PAID_GENERATION=true`. Requires a generation permit, the matching project, current project review, generation approval, settings and free local worker lock. It may claim the row, call ElevenLabs, store audio in S3, and update Sheets. `SAVE_LOCAL_AUDIO=false` disables only the extra local audio copy. |
| `node upload.js`, direct `uploadAudio()`, or legacy wrappers | Exact `DRY_RUN=false` and `ENABLE_VOICE123_SUBMISSION=true`. Requires a submission permit and the lock before queued S3 retrieval or Voice123 activity. The current submission approval, project settings, exact staged-audio hash, and scoped proposal controls are checked before actions. It may accept an invitation, attach and submit audio, and update the audit row. |
| `node approval.js` | A live approval or revocation requires exact `DRY_RUN=false`, an interactive confirmation, the named tracking ID and relevant evidence. Local `prepare` affects only the specified local audio output. |
| `node persistence-test.js --write-needs-review` | Legacy write command is disabled. Reviewed discovery persistence uses a project-specific permit. |

The provider switches are independent. The queue commands read only the
tracking ID named by the current permit and verify its Voice123 project.
The approval CLI still records a separate interactive human decision for
one named tracking ID. An execution permit cannot grant a project review,
paid-generation approval, submission approval, or voice-rights clearance.

## Offline opportunity evaluation

From the repository root, try the evaluator with synthetic data:

```sh
npm run --silent evaluate -- test/fixtures/offline-invitations.json test/fixtures/offline-preferences.json
```

For real intake, save a private JSON file outside the repository. Its top
level is an array of invitations. Use the synthetic fixture as the schema
example. Paste the project description and record what you can verify from
the invitation. Leave uncertain values absent or use `null` for data and
`unknown` for states. Duplicate project IDs, invalid dates, invalid enum
values, and unexpected fields fail the intake with a nonzero exit. Fix the
input before relying on any ranking.

| Field | What to enter |
| --- | --- |
| `projectId`, `title` | Required. Use the actual alphanumeric Voice123 project ID and invitation title. |
| `deadline` | ISO date and time with a timezone such as `2027-01-20T17:00:00-06:00`. Use `null` if you cannot establish the time or timezone. |
| `budget` | An object such as `{"amount":500,"currency":"USD"}` for a confirmed single amount. Use `null` for an unreported budget or a range with no confirmed amount. |
| `description` | The project description or a faithful summary. |
| `invitationStatus` | `new`, `revision_requested`, `closed`, `withdrawn`, `declined`, or `unknown`. |
| `proposalStatus` | `open`, `closed`, or `unknown`. Record `open` only when the invitation explicitly supports it. |
| `scriptAvailability` | `verified_usable` after you reviewed actual audition copy, `available` if copy exists and usability is unverified, `missing`, or `unknown`. |
| `scriptText` | Optional. If provided, the existing script heuristic flags likely instructions, attachment references, and short material for review. You can use `verified_usable` without copying client script into the intake. |
| `attachmentRequirements` | `none`, `required`, or `unknown`. Required files keep the item in manual review. |
| `rightsStatus` | `reviewed_no_concerns` after reviewing the usage terms for this opportunity, `review_required`, or `unknown`. This is triage evidence only. |

An optional separate preferences JSON file has `preferredTerms` and
`avoidTerms` arrays and a `budgetTargets` object keyed by currency. Terms
are case-insensitive substrings matched against title and description.
Each distinct preferred hit adds two points, each avoid hit subtracts
two, and a reported budget earns or loses two relative to its currency's
target. Unreported budgets and currencies without a target earn zero.
Preferences affect ordering only. If the preferences file is omitted or
empty, opportunities within a classification sort by earliest known
deadline, then project ID.

Run with your own local paths:

```sh
npm run --silent evaluate -- /absolute/path/invitations.json /absolute/path/preferences.json
```

Review `eligible` items first. They have a confirmed future deadline, a
new invitation open to proposals, and usable audition material based on
the supplied evidence. Resolve the listed reasons for `needs_review`
items and rerun with updated evidence. `ineligible` indicates a confirmed
closed or inactive invitation or a passed deadline. A report is a
point-in-time shortlist and grants no operational approval. Output
contains title, deadline, budget, findings, and score breakdown. Keep it
private as opportunity data.

### Salazar Media Business Policy v1

Use the existing preferences format with the supplied
`salazar-media-preferences.json` and opt in explicitly:

```sh
npm run --silent evaluate -- --salazar-policy-v1 test/fixtures/offline-invitations.json salazar-media-preferences.json
```

The preferences object still accepts only `preferredTerms` and `avoidTerms`
(arrays of nonempty strings) and `budgetTargets` (three-letter uppercase
currency codes mapped to nonnegative numbers). The flag requires a
preferences file. Omitting it retains the existing evaluation and scoring.

With this policy, a reported zero amount or a clear, uncontradicted
compensation statement in the description makes an invitation ineligible.
The text check is intentionally conservative. Title-only, conditional,
and ambiguous wording can flag business risk. Common negations such as
“This is not unpaid work” do not count as risk matches. Conflicting budget
evidence requires review and contributes zero budget points.

A positive USD budget below the configured target of $100 requires
review unless an independent disqualification applies. $100 and above
earn the existing positive budget points. Unreported budgets earn no
budget points. Preferred-category aliases count once per category, and
risk terms affect fit without independently disqualifying an opportunity.
An open proposal deadline less than 24 hours away adds an `Urgent:`
reason without changing classification. The report fields and existing
classification values are unchanged. Disqualifying reasons appear before
secondary review reasons and warnings.

### Salazar Media Business Policy v2

Use v2 to assess business eligibility from local, operator-supplied
invitation JSON. Required recording material must be English. Payment
must go through Voice123, be explicitly secured, and follow standard
Voice123 secured payment terms without separately negotiated extensions.
Compensation must be positive. Auditions, project communications, and
business transactions must stay on Voice123.

Run from the repository root with the existing Salazar preferences:

```sh
npm run --silent evaluate -- --salazar-policy-v2 /absolute/path/invitations.json salazar-media-preferences.json
```

The CLI uses the current clock. For a reproducible comparison, pass a
fixed timestamp in milliseconds to the exported evaluator:

```js
const { readFileSync } = require("node:fs");
const { evaluateOpportunities } = require("./evaluate-opportunities");
const invitations = JSON.parse(readFileSync("/absolute/path/invitations.json", "utf8"));
const preferences = require("./salazar-media-preferences.json");
const now = Date.parse("2099-05-18T00:00:00Z");
const report = evaluateOpportunities(invitations, preferences, now, { salazarPolicyV2: true });
console.log(JSON.stringify(report, null, 2));
```

The CLI requires a preferences file with either policy flag. Use only
one of `--salazar-policy-v1` and `--salazar-policy-v2`, or only one of the
corresponding programmatic options `salazarPolicyV1` and
`salazarPolicyV2`. Selecting both is an input error. Omit both for the
default evaluator. Legacy invitations remain valid in all modes. Remove
`salazarEvidence` from invitations for default or v1 evaluation because
their strict schemas reject the field.

#### Evidence and classification

Supply the optional nested `salazarEvidence` object with these
case-sensitive values.

| Field | Accepted values |
| --- | --- |
| `scriptLanguage` | `english`, `non_english`, `mixed`, `unknown`, `conflicting` |
| `paymentChannel` | `voice123`, `external`, `unknown`, `conflicting` |
| `paymentSecurity` | `secured`, `unsecured`, `unknown`, `conflicting` |
| `paymentTerms` | `platform_standard`, `nonstandard`, `unknown`, `conflicting` |
| `auditionChannel` | `voice123`, `external`, `unknown`, `conflicting` |
| `communicationChannel` | `voice123`, `external`, `unknown`, `conflicting` |
| `transactionChannel` | `voice123`, `external`, `unknown`, `conflicting` |

- Determine script language from all required recording material, including
  required alternate takes. Use `mixed` when required material includes
  English and non-English copy. Description language alone establishes
  neither.
- Record `secured` and `platform_standard` only with explicit evidence for
  each. A positive budget, an invitation, visible upload controls, or
  Voice123 as the payment channel are insufficient. Record separately
  negotiated payment extensions as `nonstandard`.
- Record `external` when off-platform activity is required. If an external
  route is optional and a fully compliant Voice123 route is explicitly
  available, record the compliant route. The evaluator never recommends
  an external route. External reference links alone do not establish
  off-platform business activity.
- Use `unknown` when evidence is insufficient and `conflicting` when
  evidence contradicts itself. Omitted or null objects and values become
  `unknown`. Unexpected keys, invalid types, and unsupported values fail
  input validation.

Confirmed disqualifications make a project `ineligible`. Otherwise,
unconfirmed or conflicting evidence and other review findings make it
`needs_review`. With both sets of findings clear, it is `eligible`.
Reports list disqualifications first, review findings next, and advisory
warnings last. Existing proposal, invitation, deadline, script usability,
attachment, and usage-rights checks still apply.

Keep the existing `budget` object with `amount` and `currency`. Confirmed
unpaid work and a reported zero budget disqualify. An unreported amount
or conflicting compensation evidence requires review. Positive USD
amounts below the preferred USD 100 target also require review. Budget
and category fit cannot override a disqualification.

V2 adds an urgency advisory when the deadline is strictly between now
and 24 hours away, the invitation is new, a revision request, or unknown,
and proposal status is open or unknown. With unknown proposal status,
the advisory explicitly preserves that uncertainty. Urgency can accompany
an ineligible result and does not change classification.

#### Synthetic compliant invitation

With the fixed timestamp above, this invitation is eligible.

```json
[
  {
    "projectId": "SYNTHV2",
    "title": "Museum narration",
    "deadline": "2099-05-20T16:00:00-05:00",
    "budget": { "amount": 500, "currency": "USD" },
    "description": "Record an English narration for a synthetic museum exhibit.",
    "scriptText": "The harbor lanterns cast a warm glow over the boats as visitors arrived for the evening tour.",
    "scriptAvailability": "verified_usable",
    "attachmentRequirements": "none",
    "invitationStatus": "new",
    "proposalStatus": "open",
    "rightsStatus": "reviewed_no_concerns",
    "salazarEvidence": {
      "scriptLanguage": "english",
      "paymentChannel": "voice123",
      "paymentSecurity": "secured",
      "paymentTerms": "platform_standard",
      "auditionChannel": "voice123",
      "communicationChannel": "voice123",
      "transactionChannel": "voice123"
    }
  }
]
```

#### Colgate acceptance comparison

The inline evaluator regression test reproduces invitation `IO0BMO0L0`
at `2026-11-26T05:20:00Z`. The provisional CST offset yields a normalized
deadline of `2026-11-26T19:09:00.000Z`, 13 hours and 49 minutes away.

| Policy | Classification and findings | Fit |
| --- | --- | --- |
| v1 | `needs_review` for unknown proposal and attachment status and pending rights review. No urgency advisory. | 4, with `commercials` preferred, no avoid matches, and `meets_target` budget fit. |
| v2 | `ineligible` for non-English required copy, external payment and transactions (one combined finding), unsecured payment, nonstandard terms, external audition submission, and external communications. The same review findings follow, then an urgency advisory that preserves proposal uncertainty. | Same as v1. |

The operator supplied the English description summary and structured
evidence. The regression preserves the Spanish script. The timezone,
proposal eligibility, attachment requirements, and usage approval retain
their stated qualifications. The native-speaker requirement and external
references add no separate disqualification.

Evidence collection is manual. The evaluator does not fetch links, verify
platform status or payment terms, detect script language, or independently
validate the operator's evidence. Offline eligibility grants no approval
to generate audio, upload files, submit proposals, or take other live
actions.

## Single-use permits

The local issue, revoke and reconcile APIs are in `execution-permit.js`.
No live issuance command or production permits are provisioned. An operator
would need separate authorization before issuing a real permit. Select a
previously issued permit with `VOICE_OTTO_PERMIT_ID`. The application reads
only the fixed private `.voice-otto-local/permits` store. Test code can explicitly
isolate its store in a temporary directory.

| Field | Meaning |
| --- | --- |
| `version`, `id`, `operation` | Schema version, random UUID, and exactly one of discovery, generation or submission |
| `projectId`, `trackingId` | Exact Voice123 and Sheets tracking IDs |
| `approvalSha256`, `clarificationSha256` | Exact approval evidence or reviewed discovery-plan fingerprint, and the current project-specific clarification snapshot or discovery journal fingerprint |
| `audioSha256` | Exact staged file hash for submission, null for other operations |
| `operator`, `authorization`, `createdAt`, `expiresAt` | Human and authorization reference, and a validity window of at most one hour |
| Sibling `.claim` | Immutable permit ID, recovery attempt ID and consumption time |
| Sibling `.revoked`, `.reconciled` | Separate human revocation and confirmed recovery outcome records |

Discovery previews expose plan and clarification fingerprints for review.
A missing clarification fingerprint prevents issuing a usable permit.
Discovery uses a new, unique tracking ID chosen by the operator and rejects
an existing project or tracking ID. The discovery plan includes the script
field and attachment metadata, and persistence still creates a review row.

Under the worker lock, the application creates the claim with an exclusive
file open, writes and syncs it, then revalidates. The claim is consumed before
the first project write for discovery or generation and before invitation
acceptance or file attachment for submission. For queued submission the
permit and approvals are checked before the read-only storage retrieval.
The file is hashed and checked again before it can reach a proposal control.
The same attempt rechecks expiry, revocation and binding before later actions.

A crash before the claim leaves the same permit available while still valid.
A crash after the claim, a torn claim, or a lost result leaves the operation
held. Never delete or restore a claim. A replacement in the same project
and operation requires a named human reconciliation with a verified
completion, failure or no-action outcome for the old attempt. A confirmed
submission is not eligible for another upload through this workflow.
A crash between the claim and the recovery manifest leaves the permit claim
as evidence even when the corresponding manifest event is absent.

Local file permissions and atomic creation protect cooperating processes on
one machine. They do not authenticate an operator with filesystem write
access or protect against rollback or separate hosts sharing external
credentials. Multi-host operation requires a shared transactional permit
and attempt store with an atomic claim. Stop and reconcile after an
unexpected loss or corruption of local permit state. Raw SDK access and
arbitrary local code with credentials are outside these application guards.

## Interactive offline permit issuance

Phase 11B provides a synthetic-only issuer. The production permit directory
and feature switches stay untouched. The command requires terminal input and
output and uses the local OS account and UID as the operator identity. It reads
only supplied local fixtures and has no service adapters. Queue commands and
approval commands never call the issuer.

1. Prepare a private workspace with
   `review_dir=$(mktemp -d "${TMPDIR:-/tmp}/voice-otto-issuance-XXXXXX")`. Put the synthetic
   fixture files in that directory. Use a reserved `SYNTH11B…` project ID
   containing only uppercase letters and digits, and a `synthetic-…` tracking ID.
2. Keep `projects.json` and `authorizations.json` as owner-only JSON arrays
   (mode 0600). The project fixture uses the application's approval-row shape
   (`id`, `url`, `status`, `script`, `evidence`), with `generationInputs` for
   generation and submission. Submission also requires `audioUrl`,
   `voiceSettings`, and `stagedAudio` naming a private local MP3 or WAV. Supply
   the versioned `clarifications.jsonl` journal with its checkpoint and source
   files under `sources/<project-id>/`. An optional `synthetic-history.json`
   fixture supplies known attachments and rights flags. For discovery use a
   `Pending Discovery` fixture with project review evidence and a matching
   `discoveryPlan` that will persist `Needs Review` and a null script.
3. Have the authorization owner supply one active record in
   `authorizations.json` with `reference`, `uid`, `operator` (local account
   name), `projectId`, `trackingId`, `operation`, `status` (`active`),
   `createdAt` and `expiresAt`. The record authorizes one exact pair of IDs
   and one operation. Keep it separate from review evidence.
4. Run the command in a terminal with one operation.

   ```sh
   node issue-permit.js --workspace "$review_dir" --project SYNTH11BVOICE \
     --tracking synthetic-11b-tracking --operation generation \
     --authorization fixture-decision --minutes 15
   ```

   Use `discovery`, `generation` or `submission`. For submission include
   `--audio-sha256 <64-lowercase-hex-digits>`. The default lifetime is 15
   minutes, capped at one hour and at the earliest required approval or
   authorization expiry.
5. Compare both IDs, status, script fingerprint, approval and clarification
   fingerprints, rights clearance, destination and planned side effects in
   the displayed summary. Enter exactly `ISSUE SYNTH11BVOICE generation` for the
   example. Closing the prompt or entering different text cancels issuance.
   The issuer reads and validates the evidence again under the issuance lock.
   It changes no status or approvals.

The append-only issuance audit is one exclusive `<permit-id>.issued` record
per permit in the private workspace's `permits` directory. It records version
and event, permit ID, creation time, project ID, tracking ID, scope, operator
name and UID, authorization reference, exact confirmation, sanitized summary
and its SHA-256, permit SHA-256, and record SHA-256. It contains no script text,
storage URLs or credentials. Audit is written before publishing the permit.
An orphaned, missing or corrupt audit requires investigation. Preserve all
files and establish what was published before considering another issuance.
The audited workspace also retains its initialization marker and one
`<permit-id>.consumed` record outside the permit directory. The consumption
record and claim must agree on permit ID, attempt ID, and timestamp. A missing
permit directory after initialization, a missing half of a consumption
record, or an unmatched consumed permit blocks use or reissuance. Preserve
the workspace and reconcile against independently retained receipts and
the recovery manifest. Recreating storage after loss is never proof that
an action did not happen.

For isolated test stores, local `revokePermit(id, {operator, authorization},
directory)` appends a `.revoked` record. An operator can also set a fixture
grant's status to `revoked` to stop future issuance under that reference.
Use permit revocation to stop an already-issued permit. An expired or
revoked unclaimed permit may be replaced after a fresh interactive review.
A claimed permit remains consumed. After verifying the external outcome,
record the attempt with `reconcilePermit(id, {operator, authorization, outcome},
directory)` using `confirmed-complete`, `confirmed-no-action` or
`confirmed-failed`. An uncertain outcome stays blocked. A stale issuance
lock can be cleared only after verifying the owner is gone and checking
the audit, claim, and recovery records. Preserve a record of the intervention.

The account check and audit hashes protect against accidental misuse and
detect inconsistent records. Anyone with equivalent local write access can
change the fixture registry or rewrite local records and their hashes. A
script controlling a pseudo-terminal can impersonate terminal input.
Production issuance would need independently managed authorization and
audit storage appropriate to that threat model. The synthetic issuer and its
low-level issue helper cannot mint a production permit.

### Deployment boundaries

| Scenario | Readiness and required controls |
| --- | --- |
| Attended, single machine | Suitable for offline rehearsal with a trusted OS account, a private workspace, the worker lock and manual reconciliation. A controlled live test still requires separate approval and a separately established real-project authorization and audit path. |
| Unattended local automation | Terminal confirmation can be replayed by a pseudo-terminal. Use an independent authorization source, a separate executor identity that cannot grant itself approval, and an audit trail retained outside that identity's write access. |
| Multiple machines sharing accounts | Machine-local claims and locks cannot deduplicate between hosts. Require a shared transactional claim and attempt store, independent authorization, and protected off-host audit retention. Ambiguous external outcomes still require manual reconciliation. |

Supported issuance commands read the operator registry and have no grant
creation or mutation operation. The low-level fixture helper cannot issue for
the interactive synthetic namespace. A same-UID process can still simulate
confirmation through a pseudo-terminal and can edit local files outside the
application. Loss or rollback of the entire workspace can erase both the
claim and its independent local copy. Retain receipts outside the executor's
write access before relying on this workflow for live operations.

## Local recovery records

`node recovery-manifest.js` reads private JSON Lines attempts under
`.voice-otto-local/recovery` and prints reconciliation candidates. It makes
no service requests and has no cleanup or retry action. Generation and
submission record attempted boundaries before the external request and
record confirmation before publishing or auditing completion. Records
include project and tracking IDs, operation, attempt and permit IDs, timestamps,
audio SHA-256 and storage reference when known, and hashes of the exact
approval evidence and clarification snapshot. They omit credentials,
script text and signed URLs. A malformed or torn record blocks the report
and requires manual reconciliation.

| Last durable evidence | Required recovery |
| --- | --- |
| Generation started or a row remains `Processing` | Preserve the claim. Reconcile provider usage or an existing response. Process or lock termination does not establish failure. |
| Audio generated, storage not confirmed | Locate the retained local bytes, compare SHA-256, and reconcile the intended key if a storage attempt was recorded. If bytes or the outcome cannot be established, hold the record. |
| Storage confirmed, publication missing | Compare an offline row export by both IDs, storage reference and exact hash. Treat unmatched or conflicting results as orphan candidates. Check whether the object was subsequently published or shared before considering cleanup. |
| Invalid storage configuration or reference | Stop before paid work when configuration is invalid. Missing or unclear storage confirmation after an attempted put requires reconciliation of its recorded key. |
| `Submission Uncertain` or attempted with no confirmation | Reconcile against authoritative Voice123 evidence for the exact project. Preserve the uncertain status and attempt ID. |
| Confirmation recorded, final audit write failed | Reconcile the existing submission and repair only its audit entry after explicit authorization. Keep the claim held. |
| Worker terminated or competing worker blocked | The host lock releases on exit. Inspect durable claims and attempt records before allowing another operation. |

Neither an orphan-candidate flag nor an empty local report establishes
remote object state. Any remote verification, cleanup, status repair, or
retry needs separate explicit approval. Do not automatically retry an
uncertain submission or an interrupted paid generation.

## Checklist for controlled production

- [ ] Name one authorized operation, project ID and tracking ID.
- [ ] Verify the selected script and attachment manifest against exact hashes.
- [ ] Review the applicable rights and authorization agreement.
- [ ] Confirm the current clarification snapshot and resolve pending identities or replies.
- [ ] Verify independent project review and generation approval, including the voice, model and settings.
- [ ] Verify separate submission approval and the exact final audio SHA-256.
- [ ] Verify storage identity and the separately authorized bucket permissions.
- [ ] Verify the Voice123 project identity, eligibility and post-accept controls.
- [ ] Confirm the positive submission indicator and record the final audit outcome.
- [ ] Check local recovery evidence, reconcile any earlier claims, and assign a human owner for failures.
