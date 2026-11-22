# Distinct-UID authority rehearsal

## Host assessment

The available host ran macOS 26.7.2 on x86-64 as UID 501. The installed
Docker Desktop daemon was unreachable even outside the shell sandbox.
No other local VM runner was found. No service was started, no password
or sudo was used, and no account or workspace permission was changed.
The distinct-UID rehearsal therefore remains pending.

## Exact prerequisite

Provide an already running, disposable Linux VM with networking disabled,
Python 3.9 or later, Node.js 20 or later, and a guest-root shell allowed to
switch child processes to distinct nonprivileged numeric UIDs. Use guest-root
only in that disposable environment. Do not use host sudo or create host
users. A prebuilt Linux container with those tools, no network, no host
mounts, and guest UID/GID-switching support is an alternative once the
operator has independently made its runtime available.

Transfer only the following allowlisted files into the guest with their
relative paths preserved. Include no project workspace mount, credentials,
browser profile, environment files, or production records.

- authority-service.js and authority-client.js
- approval-evidence.js, voice123-projects.js and attachment-review.js
- clarification-log.js and connectivity-local.js
- tools/authority-isolation/run.py, peer-gateway.py and role.cjs

In the guest with the network disabled, run:

    python3 tools/authority-isolation/run.py --disposable-linux-guest

The harness rejects other platforms and non-root launch. It provisions a
temporary directory, switches child processes to nonprivileged numeric UIDs,
and removes its temporary fixtures on exit. It creates no OS accounts. The
signed commands use generated synthetic key material. Standard output contains
the observed role UIDs, ownership and mode metadata, filesystem denial error
codes, and the count of passed checks. It never prints private keys.

## Isolation model under test

| Role | Fixture UID | Required access |
| --- | --- | --- |
| Authority service and peer gateway | 42001 | Owns authority verification material, grants, ledger, state head and audit records. Publishes a group-restricted gateway and uses a private upstream socket. |
| Executor | 42002 | Member of the client group. Through the gateway it may open, validate and claim. Direct state, key, independent-checkpoint and upstream-socket access must fail. |
| Operator authorization | 42003 | Owns the separate private operator signing key. Through the gateway it may send signed operator requests. |
| Guest provisioner | 0 | Creates the disposable fixture and owns the independently retained checkpoint. The authority can read the published checkpoint and cannot replace it. |

The authority owns its service key material. The operator key is deliberately
operator-owned so the service cannot create an operator signature; the
authority stores only its pinned verification key. The authority's local
head and the independent checkpoint are distinct records.

The Linux-only rehearsal gateway checks kernel-reported SO_PEERCRED and
current UID policy on every request, before forwarding to the private socket.
It ignores caller-supplied identity strings. The authority separately verifies
operator signatures, bindings, and current claim state. Missing peer
credentials, unreadable policy or an unavailable upstream fail closed.
The harness keeps a socket open during policy revocation to test denial on
the same connection. It also tests permission denial on a new connection
after removing socket-directory traversal. Unix mode changes alone do not
revoke already-connected descriptors.

Linux reports the peer UID captured at connection time; rereading the
credential does not establish a new identity after a descriptor is delegated.
Do not share executor or operator socket descriptors. Already-admitted requests
can finish during a policy change. Terminate outstanding connections and pause
workers during containment; reconcile any operation whose outcome is unknown.
Native macOS peer identity enforcement remains outside this Linux harness.
The Node authority's existing listener must remain private behind the gateway.
This fixture gateway is not a production deployment component.

## Pass criteria

The command must exit zero with all checks marked PASS and distinct effective
UIDs shown in the output. Inspect direct-mutation denials and socket ownership,
the policy denial on an existing connection, the single winner across three
executor processes, and rejection of unauthorized issue, revoke and reconcile
calls. The crash, restart, stale-evidence, missing-checkpoint and rollback
checks must also pass. An ambiguous outcome must block a replacement until a
verified reconciliation. Retain the output without secrets. Syntax checks on
the host do not count as any of these results.

## Completed Ubuntu VM rehearsal — 2026-11-22

The earlier host assessment records the initial inability to run the
distinct-UID rehearsal on macOS. The rehearsal was subsequently completed
in a disposable Ubuntu Linux VM.

Execution command (from the VM staging directory):

    sudo python3 tools/authority-isolation/run.py --disposable-linux-guest

The harness reported 11 distinct-UID checks passed.

Observed identities:
- Authority service and gateway: UID 42001
- Executor: UID 42002
- Operator: UID 42003
- Independent checkpoint owner: UID 0

Verified checks:
1. Executor opened and validated a signed permit through the gateway.
2. Kernel denied executor access to protected files, keys, checkpoints,
   authority storage, and socket mutations.
3. Executor could not connect directly to the private upstream socket.
4. Privileged requests required OS identity and operator signature.
5. Replayed signed operator commands were rejected.
6. Stale approval fingerprints were rejected.
7. Revocation denied new requests and an already-connected client.
8. Exactly one of three competing executor processes claimed the permit.
9. A post-claim crash blocked replacement while the outcome was unresolved.
10. Authority outage, crash claim, and persisted replay protection passed.
11. Missing independent checkpoint and rolled-back ledger blocked startup.

Result: PASS — 11/11 distinct-UID security checks.

These results validate the tested prototype controls in the disposable
Linux environment. They do not establish production deployment readiness.
