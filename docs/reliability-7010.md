# v5.0.7010 automated recovery validation

## Implemented

Automatic mode can reopen a completed saved chat when the exact task/model/effort/compaction key, connector identity, and last native answer digest match a stored checkpoint. The reopened page must still have the same final turn ID, completed-turn action, no generation control, and the same visible content hash. Verification is bounded. The checkpoint is consumed before further work, preventing reuse after an interrupted subsequent turn. A mismatch fails explicitly without sending a prompt. Missing or ineligible checkpoints use the existing fresh-context path. Zero Risk manual mode continues to save chat links but does not inspect or automatically restore page checkpoints.

## Automated evidence

- Fixture daemon is killed and the real supervisor restarts it with a different PID and accepting-turns health evidence.
- Saved restart selection rejects changed history, task/epoch, connector, missing completion and ambiguous records. Navigation failure releases the fixture tab without submitting.
- Twelve compaction epochs reload authority through fresh store objects and reject changed summary text.
- Interrupted downloads, checksum mismatch and worker startup failure remove candidate artifacts and allow retry; no installer runs.
- Existing runtime replacement tests cover candidate validation failure, injected locked promotion, restoration of the previous runtime and successful retry.
- Existing supervisor tests cover failed startup and failed shutdown compensation, tunnel readiness failure, crash loops, cancellation and active-turn drain rejection.

## Deferred by request

The user requested automated tests only. Live ChatGPT browser crashes, real tunnel reconnects, live saved-chat/connector execution and repeated live compaction are not certified. These automated fixtures do not establish full Windows NSIS rollback after an actual installer modifies an installation. No production crash, installer launch, account cookie transfer or login was performed.

The installer is for manual installation. This build includes the existing local changes from earlier increments.
