# Independent authorization and audit

## Current boundary

The audit ran as macOS UID 501. The repository, environment file, processing
history, browser profile and private runtime directories share the executor's
owner. Ordinary owner access permits changes to code, switches, browser data,
attachments, the clarification journal, and workspace grant, permit, and recovery
records. The managed session separately restricts some paths, including Git
metadata. The production permit store was absent. Provider grants and credential
validity were outside the audit.

A process with the same UID can forge terminal input, copy accessible secrets, or
roll back the workspace. Hashes can detect rollback only relative to a trusted
checkpoint. Stolen provider credentials may allow direct calls outside the app.
The design assumes a trusted OS, administrator and authority service binary.

## Architecture choice

| Option | Security and recovery | Complexity and cost | Fit |
| --- | --- | --- | --- |
| Separate account and manual files | Protects issuer-owned files. A claim helper is still needed for atomic consumption and recovery. | Low infrastructure cost, more manual work and handoff risk. | Useful as a first provisioning step. |
| Local service under a separate identity | Isolates the ledger and grants, serializes claims and preserves unknown outcomes. Protected checkpoints help detect ledger rollback. | Moderate setup for OS users, socket ACLs, keys, supervision and backups. No hosted infrastructure. | Recommended for attended single-machine use. |
| Independently managed remote service | Enables cross-host atomic claims and protected audit retention, with a new network availability dependency. | Higher setup and recurring cost, plus network identity and incident response. | Better when multiple hosts or unattended execution are needed. |

## Trust and responsibilities

- **Human operator.** Review the exact action and evidence. Sign the action,
  its payload, the pinned authority ID, a nonce, and a short deadline. Keep the
  signing key outside the executor and issuer identities. A live design needs
  a trusted transaction display and deliberate signing action. A PTY phrase is
  readily automated.
- **Authorization and permit issuer.** Run as a dedicated service account with
  an operator public key pinned in trusted configuration. Store grants and
  permits under that account. Place the Unix socket in an authority-owned
  directory with tightly scoped traversal and connection rights. The executor
  must not be able to replace the socket or control the launcher or service code.
- **Voice-Otto executor.** Give it socket access for open, validate, and claim,
  without write permission on issuer configuration, state, operator keys,
  or audit retention. Keep the executor's existing approval gates and worker
  lock. Protect browser cookies as provider credentials.
- **Authoritative audit and recovery recorder.** The service commits a claim
  before permitting any side effect. The independent recovery role verifies
  signed records, retains ledger copies and checkpoints outside the executor's
  and preferably the issuer's write access, and reconciles with provider
  receipts. The prototype supplies a verifier, with no privileged auditor
  account or audit export pipeline provisioned.

A malicious executor with independently usable provider credentials can bypass
an application gate. Before relying on the gate against that threat, use scoped
credentials or put provider access behind a broker that enforces authority
decisions. A stolen operator signing key can authorize fraudulent commands until
rotated. This design offers no protection against a compromised administrator
or OS.

## Offline prototype and recovery

The service requires explicit initialization and serves only a local Unix
socket. Signed commands grant, revoke, issue or reconcile. Each grant binds one
operation to exact synthetic project and tracking IDs, approval and clarification
fingerprints, and a submission-only audio SHA-256. It can issue one short-lived
random permit with expiry at or before the grant's one-hour limit.

The service holds an exclusive process lock. Synchronous validation and durable
ledger commits serialize competing claims. Each acknowledged claim leaves an
unresolved outcome with the permit and attempt ID. Authorization and reconciliation
events retain their signed commands. An auditor can verify the chain, operator
signatures and an independently retained head. A simulated executor crash or
loss of its local recovery files leaves the authoritative claim in place.

A claim or response with an unknown outcome requires manual reconciliation.
A replacement is blocked until the operator signs a verified outcome for the
exact attempt. A confirmed completion blocks repeating that project and scope.
Verified no-action or failure permits a new authorization. An unclaimed permit
can still be used before expiry or revocation. An interrupted commit, stale
service lock, missing store or ledger inconsistency calls for inspection and
reconciliation. Never reinitialize the store as part of automatic startup.
Restoring the whole authority store is detectable only up to the newest
checkpoint retained somewhere independent.

The client preserves the existing permit handle shape (permit, validate, claim).
It is offline-only and has no production call sites. The service checks a
caller-supplied current binding against the operator's signed grant. A
cooperative executor keeps validating fresh inputs through existing gates. A
malicious executor could supply stale material as current unless live evidence
is independently sourced or superseded grants are revoked through a trusted
review component. No local claim can atomically prove the provider outcome.

The original Node.js tests run the authority and executor in separate
processes with separate signing capability under one OS UID. They demonstrate
that the API rejects unsigned authority mutations.

A subsequent rehearsal in a disposable Ubuntu Linux VM passed 11/11
distinct-UID security checks. It verified filesystem and socket isolation,
operator authorization, replay protection, revocation, concurrent claims,
and selected crash and rollback protections. See AUTHORITY-UID-REHEARSAL.md
for the test conditions and results.

Production deployment still requires trusted launch, independent audit
retention, credential containment, and validation under the intended
deployment identities and configuration.

## Migration without history loss

1. Keep production disabled. Snapshot existing processing history, approvals,
   clarifications, permits and recovery records. Reconcile unresolved actions
   before cutover and retain historical records read-only.
2. Provision separate operator, authority, and executor identities, a trusted
   launcher and socket location, pinned verification configuration and off-executor
   audit retention. Test actual ACLs, restart recovery and backup restoration.
3. Independently source current approval and clarification evidence or deliver
   trusted signed revocations. Establish credential containment before testing
   any external operation. Repeat the offline rehearsal under the real identities.
4. With separate live authorization only, connect all direct and queued paths
   to the authority client with no fallback to workspace permits. Archive old
   permits and use a fresh independent authorization for each approved operation.
5. Retain dry-run, separate operation switches, worker locks, current approval
   validation, exact project selection, staged-audio checks, the uncertain
   submission latch, local recovery diagnostics and manual reconciliation. The
   executor-owned issuance journal and mirrored claims become redundant as
   enforcement after cutover. Preserve them as historical evidence.
