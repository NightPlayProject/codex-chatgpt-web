# v5.0.7009 reliability and saved chats

Settings > Save chats in ChatGPT switches newly allocated task chats between temporary (default) and regular ChatGPT conversations. Existing retained tasks preserve their original mode. Regular chats follow the account's history, memory and personalization settings. Recent saved chats lists links for review; it is not automatic replay after a restart. The local index retains up to 100 links, with the ten most recent shown. Compaction continues to create a fresh chat epoch.

The worker now extends the assistant-DOM grace period while a newly submitted user turn has a visible generation control. An observed response that temporarily unmounts also remains live while generation is visible. Idle and explicit task deadlines still apply; accepted messages are not resubmitted by this change.

Diagnostics now redact common provider tokens, credential fields, HTTP authorization/cookies and multiline private keys. Stream suppression is independent per child output stream. Raw command results are preserved for JSON consumers. Historical log export is sanitized, including rotated key blocks. This does not scrub existing log files in place or guarantee recognition of arbitrary unknown secret formats.

Recovery tests cover drain ambiguity and candidate-promotion failure with restoration and retry. Full live ChatGPT crash/disconnect certification, repeated live compaction/restart, and installer rollback after actual application startup failure remain outstanding. No production crash was injected and no installer was run during this work.

Doctor was retested independently against the installed 5.0.7008 runtime and exited normally in about one second. The earlier lingering combined command included a recursive filesystem search and did not establish a doctor defect.
