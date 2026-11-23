# Local clarification evidence

`clarification-log.js` stores local evidence in an append-only JSON Lines
journal. It has no inbox client, sender, or automatic ingestion. The journal
must live in a private directory outside production processing history.

Set `VOICE_OTTO_CLARIFICATION_LOG` to its absolute path. Set
`VOICE_OTTO_CLARIFICATION_SOURCE_DIR` to an absolute private directory
containing each project's source terms and agreement under
`<VOICE123_PROJECT_ID>/<filename>`. Existing attachment verification uses
`VOICE_OTTO_ATTACHMENT_DIR` separately.

Each record has a schema version, sequence number, previous-record hash,
event, and record hash. Its sibling `.head` file records the last sequence
and hash. Both files are checked before use. Keep both files together in
backups. A partial append, missing or inconsistent checkpoint, or stale
writer lock requires manual reconciliation. The hashes detect corruption
and journal-only truncation. An operator able to replace both files can
defeat this local integrity check.

## Recording and reviewing new material

Use `appendClarification(filename, event, registry)` with verified project
metadata or a preverified source/thread binding. Message events store project
ID and title, sender, recipient, direction, exact text, time, thread and
message identifiers, attachment and agreement versions and hashes, and
unresolved questions. Conflicting associations are rejected. A new inbound
reply requires fresh review even if its text appears to be informational.
An identical duplicate or an unrelated project's reply leaves the
project's reviewed snapshot intact.

A missing or ambiguous participant remains unresolved. A human can record
an `identity-resolution` event naming the original message record hash,
verified participants, reviewer, and verification source. The original
record stays intact. Resolution from a different project or thread is
rejected.

Once a human reviews the current material, append a `project-material`
event with the following fields in addition to the usual source, project,
and timestamp metadata:

- `reviewer` and `verifiedSource` identifying the human review and its source
- `reviewedThrough`, the hash of the latest inbound message or identity
  resolution, or explicit `null` when the project has none
- `script`, with `version` and `sha256` of the selected recording script
- `attachments`, the reviewed list of filenames, versions, and SHA-256 hashes
- `terms`, with the local filename, version, and SHA-256 of the project terms
- `agreementRequired`, an explicit boolean, and `agreement`, with the local
  filename, version, and SHA-256 when applicable, or explicit `null`

The snapshot must include attachment and agreement revisions from new
replies. The application checks the source file bytes for terms and the
agreement and checks the attachment manifest against reviewed local files.
Known voice-rights flags require the actual agreement source. The approval
review JSON must explicitly identify the current `clarificationSnapshotHash`.
A project-material record summarizes reviewed sources. TTS rights clearance
and each approval still require their own human decision.

## Approval invalidation

Version 2 approval evidence binds the project and review to the current
journal snapshot. Older approvals require fresh project review. The
interactive approval command and direct generation and submission
guards check the journal and local sources. Appending a clarification
does not write a project status, create an approval, or start any action.

| Changed material | Evidence that becomes stale |
|---|---|
| Script, attachment manifest, project terms, or agreement | Project review, generation, and submission |
| Current voice, model, or generation settings | Generation and submission |
| Upload-ready audio bytes | Submission |

A fresh snapshot alone cannot renew earlier approvals. Keep the source
files and configured journal current. Changes that have not been captured
locally are outside the application's visibility.

## Future outbound safeguards

The journal can model send attempts and reconciliation, but cannot send
messages. A recorded attempt needs a human and an authorization reference.
An interrupted or ambiguous attempt stays blocked pending manual
reconciliation. A new ID cannot bypass an unresolved attempt for the same
message and thread. A fresh send after verified non-delivery requires
separate authorization. Voice123 proposal `Submission Uncertain` status
retains its independent no-retry guard.
