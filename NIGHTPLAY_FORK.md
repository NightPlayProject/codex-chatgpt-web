# NightPlay fork maintenance

This repository is a maintained fork of `miuuyy/codex-chatgpt-web` for long-running Codex projects.
The `main` branch is kept as a fast-forward mirror of upstream. Fork-specific fixes live on `nightplay`.

## Why this fork exists

The first NightPlay patch makes completed ChatGPT Web compaction handoffs durable across bridge/launcher restarts. Upstream v5.0.6 kept the compaction authorization checkpoint only in process memory, so a valid context-only continuation could lose its proof after a daemon restart and fail with:

`ChatGPT web current user message conflicts with native Codex turn_id metadata`

The fork persists only SHA-256 hashes and native identity scope. It does not persist prompt text or compaction summary plaintext, and it keeps the upstream fail-closed thread/turn/model/effort/source checks.

## Upstream sync model

- `main`: upstream mirror only. Never put fork patches directly on this branch.
- `nightplay`: release/default branch containing the fork patches.
- `.github/workflows/upstream-sync.yml`: every six hours (and on manual dispatch) fast-forwards `main` from `miuuyy/main`, then opens or refreshes a PR from `main` into `nightplay` when upstream advanced.
- Upstream changes are therefore reviewed through an ordinary merge PR instead of force-pushing or silently overwriting fork patches.

## Release numbering

Fork releases use ordinary stable semver so GitHub's `/releases/latest` endpoint and the existing launcher/installer update flow keep working. For an upstream base `X.Y.Z`, the first NightPlay build uses patch `(Z + 1) * 1000 + 1`; additional fork-only builds increment that final patch value.

Example: upstream `5.0.6` -> NightPlay `5.0.7001`. If upstream moves to `5.0.7`, the first synced NightPlay build becomes `5.0.8001`.

This deliberately avoids prerelease tags because the launcher's stable update channel and installer resolve GitHub's latest non-prerelease release.
