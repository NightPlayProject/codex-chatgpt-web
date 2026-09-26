# Upstream v6.1.0 port

This branch is based on miuuyy/codex-chatgpt-web tag `v6.1.0` at commit
`293341084ac7a1ddd2de12fede3706023f5b6474`. The Windows test build is
`6.1.0-test.2`.

The launcher Settings component keeps the upstream v6.1.0 controls and order.
The only added Settings control is Codex Wallpapers. In particular, the
upstream **New browser chat for each turn** and **Save chats in ChatGPT**
switches use their original runtime configuration methods. Browser tabs read
the same saved-chat preference, so the displayed switch controls their mode.

The port adds the Codex account switcher page, bundled native Windows
Computer Use MCP setup, the 500k Sol context window with 400k auto-compaction,
Codex Wallpapers, and the official Codex app Send-button integration for
ChatGPT Web routed models. Supporting fork fixes remain where those features
depend on them.

Verification: `bun run verify` passed with Bun 1.4.0. A Windows installer was
built, and a separate unpacked executable passed `--launcher-smoke-test`
without installing it. The built renderer was visually checked with an
isolated launcher snapshot; its JavaScript and CSS hashes matched the files
inside the unpacked package. Read-only checks detected the installed official
Codex app and account store and found the Send-button integration sites in
Codex 26.924.1866.0. Live account switching, MCP registration, and official
app injection require running this build and were not part of the build check.
