# Production authorization and recovery

Keep dry-run active and paid generation and submission disabled by default.
Shell overrides are effective when the application loads the environment file.
The following table documents required conditions for supported entry points.
A setting that enables an operation does not authorize using it.

| Entry point | Required conditions and effects |
| --- | --- |
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
