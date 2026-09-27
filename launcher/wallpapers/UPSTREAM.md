# Codex Wallpapers

Vendored from https://github.com/SikJa/codex-wallpapers at
`054348d193b4f68a0f96c1ae0f900776c2d2616c` under the included MIT license.

The launcher uses the existing media library and renderer runtime inside the separate official
Microsoft Store Codex/ChatGPT desktop app.
Endpoint ownership verification is adapted for the official Store executable and its loopback-only
CDP endpoint; the Codex Web GPT embedded browser is never a wallpaper target.
Listener locks record their process ID so a later launch can recover stale locks.
Upstream's separate usage overlay is disabled here: Codex Web GPT owns the launcher integration.
Test fixtures and previews are translated into English.
Upstream changes are reviewed and shipped with Codex Web GPT, never fetched at runtime.
