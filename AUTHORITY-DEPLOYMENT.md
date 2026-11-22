# Authority deployment runbook

This runbook covers a synthetic rehearsal in a disposable, network-disabled
environment. The authority remains outside production execution. Keep
provider credentials, the browser profile, the project workspace, live
approvals and real project IDs out of the environment.

## Initial setup and identities

1. Use a disposable VM. A cached container image with a disabled network,
   no host mounts, and no host credentials also works for the container's
   OS-level checks. Record the OS, effective numeric UIDs and supplementary
   groups for each test process.
2. Provision distinct nonprivileged accounts for the authority, executor,
   operator and auditor. Use a dedicated socket-client group containing only
   intended clients. Grant neither the executor nor the authority administrative
   privileges. Use a trusted, administrator-managed executable and startup
   configuration that the executor cannot modify.
3. Provision the following paths in the disposable environment. Example modes
   are octal. The account and group ownership is as important as the mode.

| Asset | Owner and access |
| --- | --- |
| Authority state directory | Authority account, 0700. Keep the grant, permit, claim, reconciliation and audit journal, head, pending checkpoint, and process lock here. Private records use 0600. |
| Socket directory and socket | Authority account and socket-client group. Use a trusted runtime directory with no group write permission. Give the client group traversal only (0710) and socket connect permission (0660). Gate access on directory traversal too, since Unix socket inode enforcement varies by OS. |
| Operator signing key | Operator account, private directory 0700 and key 0600, or an independent signing device. The authority receives the pinned Ed25519 public key only. |
| Independent checkpoint and backups | Auditor-owned. Use an archive directory 0700 and a separate auditor-controlled publication directory for the latest approved checkpoint. Grant the authority read and traversal only to that published copy, with no access for the executor. Provision a distinct read-only export mechanism for ledger copies. |
| Executor scratch and local recovery | Executor account, separate from authority, signer and checkpoint paths. Treat these records as diagnostics and reconcile against the authoritative ledger. |

Record ownership and numeric mode with the platform's stat utility. Verify
directory traversal and permissions on all ancestors. Verify each effective
identity with id. In a disposable environment, check that the executor
can traverse the socket directory and cannot list or read authority state,
read the signing key, write or delete the journal, mutate the checkpoint,
or create, replace or unlink a socket entry. Check each failure under the
executor's actual UID and groups. Check permitted calls from the same
identity and denial from an unrelated UID.

## Operator authorization

- Verify the exact synthetic project ID, tracking ID, operation, approval
  and clarification fingerprints, and upload-ready SHA-256 for submission.
- Sign grant and issuance commands separately, with the intended authority
  ID and short validity. Keep signed envelopes private until delivery and
  use a new nonce for each decision. A grant authorizes one permit issuance.
- The executor may open, validate and claim over the socket. It cannot grant,
  issue, revoke or reconcile without a valid operator signature. Terminal
  input alone conveys no authority.
- Revoke an unneeded or stale grant. Independently deliver evidence updates
  and revocations before any deployment that relies on current evidence.
  The prototype compares the supplied binding with the signed grant and
  does not fetch independent evidence.

## Startup, health and shutdown

1. Generate a fresh authority identity and initialize only a new empty
   store with initializeAuthority. Have the auditor retain the empty head.
   Never reinitialize an established store after a fault. Incorporate the
   latest independently retained checkpoint into every startup. The
   prototype accepts a checkpoint value through trusted configuration and
   refuses to start without one. The launcher must choose the latest copy
   from auditor-controlled storage and reject missing, unreadable or stale
   checkpoint metadata. An arbitrary older checkpoint can weaken rollback
   detection.
2. Run createAuthority as the dedicated account, then bind authorityListener
   to the protected Unix socket. Use a restrictive umask and publish access
   only after the socket mode is correct. Run one service process per ledger.
   Treat a stale lock, pending commit, broken hash chain, invalid signature or
   checkpoint mismatch as a startup failure. There is no production launcher
   in this prototype.
3. Check the identity, socket owner and modes, journal and checkpoint
   agreement, and a read-only open or validate with an unclaimed synthetic
   permit. An arbitrary successful connection does not establish authorization.
   A health check must not claim a permit.
4. On planned shutdown, stop admitting executor work, close the listener
   and drain existing requests, then close the authority. Confirm the
   process exited and the listener is gone before restarting. Record the
   current verified head independently. Restart against the same ledger and
   pinned latest checkpoint. Confirm consumed permits remain consumed.

## Backups, recovery, and emergency shutdown

- Export consistent snapshots of the journal and head while quiesced or
  using a trusted snapshot mechanism. Validate the hash chain and operator
  signatures, capture authority ID, sequence and hash, and retain multiple
  versions outside the executor's write access. The prototype does not
  synchronously export a checkpoint with each claim. Treat the interval
  since the latest retained checkpoint as potentially incomplete after loss
  or rollback.
- After a crash, pause execution and preserve the ledger, head, pending
  checkpoint, locks, local reports and independently obtained receipts.
  Verify that no prior authority process is alive before inspecting a stale
  lock or socket. Recover only against a verified snapshot and prove the
  fate of later attempts before admitting work. When the checkpoint or a
  provider outcome cannot be established, keep the affected scope blocked.
- A missing socket or permission-denied connection fails closed. The client
  connects afresh on each request because OS permission changes cannot revoke
  a connection that is already open. For containment, close the listener and
  terminate existing connections as well as removing client access. A lost
  response after a claim could mean the claim was committed. Read the
  authority ledger through the recovery process. Reconcile the exact permit
  and attempt only after confirming completion, verified failure, or no
  external action. An unresolved result remains blocked. Never treat a
  failed audit write or missing executor recovery file as proof of no action.
- For emergency shutdown, stop the listener and worker, disable scheduling,
  and revoke relevant grants through the signed operator interface when the
  service is recovered. Contain or revoke provider credentials if an executor
  could bypass the app. Preserve audit evidence. Do not re-enable workspace
  permit execution as a fallback.

## Key rotation and migration

The prototype verifies a ledger against one pinned operator key. It cannot
rotate the key in place while validating historical signatures. For a rehearsal
rotation, freeze new grants, reconcile outstanding attempts, retain the old
ledger, public key and final checkpoint, then explicitly provision a new
authority identity and store with the new public key. Do not carry forward live
permits. Before opening the new epoch, the independent recovery role must check
old claims and confirmed completions so a new store cannot silently reopen an
operation. A production implementation needs governed key epochs or signed
rotation with independent historical verification and cross-epoch blocking.

Before any separately authorized integration, archive workspace-local permits,
approval evidence and recovery history read-only. Reconcile outstanding claims
and block existing completed scopes. Verify distinct-account access controls,
the independently protected checkpoint pipeline, fresh evidence and credential
containment. Move every direct and queued path together and disable fallback
to workspace permits. If migration must be rolled back, stop execution, preserve
both sets of evidence and reconcile before an independently authorized cutover.
No migration is part of Phase 12B.
