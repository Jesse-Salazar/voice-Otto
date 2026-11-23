# Generation and submission worker lock

Paid generation and Voice123 submission share an exclusive TCP listener on
`127.0.0.1:48672`. It accepts no commands and immediately closes incoming
connections. The port is fixed across local checkouts. If the port cannot be
bound, the operation stops before it reads or writes approval state, calls the
generation provider, or opens the Voice123 browser. Queue discovery and reads
that prepare work can occur before the lock is acquired.

The direct generation and submission functions hold the lock until their
work and cleanup finish. The operating system releases the bind on process
exit, including after a crash, SIGTERM, or SIGKILL. There is no lock file to
delete and no timeout that can take the lock from a live worker. If another
process occupies the port, identify its owner before trying again.

Process termination can leave a project marked `Processing` or
`Submission Uncertain`. These states do not qualify for another attempt.
Reconcile against the provider or Voice123 before changing the state.
Never treat release of the port as evidence that an external action failed.

This lock covers workers sharing the same host network namespace. It does
not cover separate machines or containers with isolated network namespaces.
Before running multiple machines, use a shared atomic per-operation claim,
such as a transactional database row keyed by project and action with a unique
constraint, attempt ID, and explicit reconciliation state. A lease expiry must
never make an uncertain submission automatically retryable.
