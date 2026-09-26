# Troubleshooting

This guide covers the failures reported most often in GitHub issues. Start here before reinstalling,
editing Codex configuration, or opening a new issue.

## The first five minutes

1. Install the [latest release](https://github.com/NightPlayProject/codex-chatgpt-web/releases/latest). Quit
   **Codex Web GPT** before running the installer again; updating preserves its private ChatGPT
   profile and launcher configuration.
2. In **Setup**, confirm that ChatGPT sign-in, the browser smoke test, and **Install into Codex**
   are green. The installation button says **Install models**, or **Reinstall** after setup.
3. Fully quit Codex, including its background process, and reopen it. Signing out, closing only the
   window, or starting another task does not reload the model catalog. Keep the launcher open.
4. Select a model ending in **(Web)** from Codex's model picker.
5. Run **Settings → Run doctor**. If the problem remains, reproduce it once and immediately use
   **Activity → Export safe log**.

Do not repeatedly press setup actions after they report success. The exact error and a fresh safe
log are more useful than another reinstall.

## Models do not appear, or setup remains on step 3

**Install models** updates the Codex route, but a running Codex process keeps its old model catalog.
Fully quit every Codex Desktop window and Codex CLI process, then reopen Codex while the launcher is
still running. The launcher should move from **Restart Codex** to a verified catalog state.

If the models still do not appear:

- confirm that **Codex itself** uses ChatGPT sign-in; signing into the launcher's browser is separate.
  An API-key or signed-out Codex session can show only its built-in catalog without contacting the bridge;
- open **Setup → Install into Codex** and click **Reinstall** once;
- check **Settings → Run doctor**;
- make sure another Codex wrapper is not replacing the route; and
- export a safe log after the failed catalog check.

A green step 3 followed by a browser-turn error means installation succeeded. Repeating step 3 will
not repair an unrelated ChatGPT browser or model-turn failure.

## `openai_base_url changed after setup` or a model is "not supported"

The launcher deliberately refuses to overwrite a route changed by another tool. Only one program
can own Codex's `openai_base_url` at a time. Wrappers and routers such as OpenCodex, Headroom,
OmniRoute, Codex++, CC Switch, or a manually configured provider may replace the Codex Web GPT route
for the whole installation or only for the process they launch.

Choose one route owner:

- To use Codex Web GPT, disable the other wrapper's provider/proxy mode, click
  **Setup → Install into Codex → Reinstall**, fully restart Codex, and start Codex directly rather
  than through the wrapper command.
- A tool may remain enabled only as an MCP integration if it does not replace `openai_base_url`.
- To switch away cleanly, use **Settings → Remove Codex integration** first. This restores the exact
  route that existed before Codex Web GPT was installed.

Do not hand-edit the launcher's route journal. It exists so setup and removal can fail closed instead
of silently destroying another provider's configuration. First-class external-router composition is
tracked in [#205](https://github.com/miuuyy/codex-chatgpt-web/issues/205), but is not supported today.

## Native models stop after closing the launcher

While the integration is installed, native Codex models also use the local bridge. Keep the launcher
running, or use **Settings → Remove Codex integration** before quitting it. Then fully quit Codex,
including background processes, and reopen it to load the restored route.

CLI users can temporarily restore the previous route with `codex-chatgpt-web route disconnect`.
Fully restart Codex after a route change. Starting the launcher reconnects an installed integration.

## Codex's usage-limit banner disables Send for Web models

If Codex shows **You're out of Codex and Work usage** and disables Send even with a Web model
selected, sign out of **Codex** and sign in with another account you own that can send messages.
A free account with Codex access and no blocking usage banner can be used.

Keep your intended ChatGPT account signed in inside **Codex Web GPT**; these are separate sessions.
Changing the Codex login does not reset or increase the launcher's ChatGPT Web account limits.

## Encrypted content cannot be verified after switching models

If switching from ChatGPT Web to a native Codex model fails with `Encrypted content could not be
decrypted or parsed`, check the route owner. The launcher's native route already converts Web
checkpoints into readable context and preserves native encrypted history. An external router that
sends native requests directly to OpenAI bypasses that conversion.

Use one route owner as described above. If the error persists through the launcher, export a safe log
and include both model names and whether compaction preceded the switch. Do not delete checkpoints
or strip encrypted history; this can lose task context. External-router composition remains unsupported.

## ChatGPT sign-in does not complete

The launcher must own the ChatGPT session used for model turns. Signing in to an unrelated browser
window does not automatically transfer that session.

- Complete ordinary sign-in inside the launcher-owned flow and wait until a Temporary Chat composer
  is visible.
- Do not navigate or close the launcher browser while authentication or session verification is
  running.
- If the account offers **Try another way**, an alternate authentication method can avoid a
  platform-passkey limitation.
- Passkey-only macOS accounts have a known open issue: [#209](https://github.com/miuuyy/codex-chatgpt-web/issues/209).
  If no alternate method exists, follow that issue rather than repeatedly deleting the browser
  profile; there is no safe generic workaround to claim yet.

If an ordinary login still fails, export a safe log immediately after one attempt. Include the OS,
launcher version, account tier, sign-in provider, and whether the Temporary Chat composer ever
appeared. Never upload cookies, browser storage, authentication headers, or raw profile files.

## The browser smoke test fails

The smoke test and real turns use the same current ChatGPT controls. Errors mentioning the effort
control, composer, send button, Temporary Chat, personalization, or an operational viewport usually
mean that the ChatGPT UI did not expose a structure the bridge can safely prove.

1. Update to the latest release.
2. Confirm that a normal Temporary Chat can be opened in the launcher and that the account is not
   showing a login, onboarding, capacity, or rate-limit dialog.
3. Run the smoke test one more time with the launcher visible.
4. If the same structural error remains, do not keep retrying. Export a safe log and open a focused
   bug report; ChatGPT UI drift must be fixed against the observed DOM, not guessed around.

Free and Go accounts normally expose Luna and Think without the paid-account effort selector. A
missing paid selector on those accounts is not itself a sign-in failure.

## Personalization or connector controls are not found

In ChatGPT, open **Settings → General → Language** and choose **English** explicitly, then reload
ChatGPT inside the launcher and retry once. Some browser controls depend on English labels;
changing the launcher language does not change the ChatGPT website language.
The same step applies when a model "could not be selected and verified".

## Full harness or MCP verification fails

Video walkthroughs:

- [Create an OpenAI tunnel and API key](launcher/src/assets/mcp-create-tunnel.mp4)
- [Connect the local harness and attach the ChatGPT connector](launcher/src/assets/mcp-connect-connector.mp4)

Browser-only mode needs no connector. Full harness mode requires all of the following:

- a newly created connector named exactly **Codex Native2**;
- **Developer Mode** enabled in ChatGPT;
- the exact Tunnel selected with **Authentication: None**;
- the connector and Tunnel on the same OpenAI account as the ChatGPT workspace;
- **Allow all actions** under the connector's permissions; and
- **Connect harness** completed before **Verify runtime**.

Do not rename or refresh an old **Codex Native** connector. ChatGPT caches the public MCP contract by
connector identity, so create **Codex Native2** as a new connector.

### Check the live tool catalog

After **Connect harness** succeeds, use the bridge's `codex_tool_capabilities` tool with the current
request ID. It returns the outer catalog hash, source counts for visible tools (`declared`,
`additional_tools`, or `tool_search_output`), and the availability of direct and gateway-backed
surfaces. Use `codex_tool_inventory` with `surface: "computer"`, `"browser"`, `"execution"`,
`"mcp"`, or `"agents"` to obtain exact wire names and schemas before invoking a deferred tool.
When `tool_search` appears in that catalog, invoke its exact wire name through `codex_tool_call`,
then use the exact names returned by its `tool_search_output` on the next tool boundary.
The local `/healthz` response also includes the last observed `tooling.snapshot` for diagnosing a
stale or changing Codex catalog.

### ChatGPT refuses a tool call or context compaction

Share the exact failed tool result and an **Activity → Export safe log**. An assistant saying
"safety block" without a failed tool result does not establish the cause. **Allow all actions**
does not override ChatGPT's own safety checks.

After updating, refresh **Codex Native2** in ChatGPT's plugin settings to load its current tool
descriptions. This updates the compaction tool contract; it does not remove safety restrictions.
If compaction ends without a submitted summary, the launcher reports that failure and preserves
the existing task history.

### Tools disappear on follow-up messages

If `codex_tool_capabilities` is absent, ChatGPT is using a cached connector contract. Reload the
**Codex Native2** connector, then start a new Codex turn. The bridge reports the catalog epoch so a
safe log can distinguish a stale connector from a native tool that was never advertised.

### Desktop control is missing

Desktop control is supplied by Codex through an optional native computer-use MCP. The existing
**Codex Native2** connector can forward it after Codex has loaded it. On Windows, for example:

Open the launcher's **MCP** page and choose **Set up desktop controls**. Current Windows installers
include the pinned native runtime, so Node.js/npm are not required and users do not need to run
the setup commands manually. Fully quit and reopen Codex after a new registration so its tool
catalog reloads. If an older launcher reports that its bundled component is missing, use the
manual setup below after repairing the Codex installation.

```powershell
npm install -g open-computer-use@0.3.4
codex mcp add open-computer-use -- open-computer-use mcp
codex mcp get open-computer-use
open-computer-use list-apps
```

Then start a new task. The first desktop-control request may use
native `tool_search` to load the deferred MCP tools. You do not need a separate desktop-control
tunnel or ChatGPT connector. If `list-apps` fails locally, repair the native MCP setup first; the Full harness
cannot forward a tool that Codex itself has not loaded.

The launcher records whether each declaration came from the static native catalog, `additional_tools`,
or a `tool_search_output`. Newer Responses Lite clients may send nested object maps such as
`Microsoft.windows.Computer -> get_app_state`; the parser preserves those namespaces and alternate
input schemas. If the capability report still says Computer Use is absent, inspect the current Codex
process and MCP registry: the web bridge cannot manufacture a native Computer handler that the outer
process did not advertise.

### Codex Wallpapers

Enable **Codex Wallpapers** in launcher Settings to attach the vendored picker to the separate
official Microsoft Store Codex/ChatGPT desktop app. It reads the existing
`%LOCALAPPDATA%\\CodexWallpapers\\library.json` library, validates content-addressed media before
transfer, and applies the picker to the official app's `app://` pages over a loopback-only local
debugging endpoint. Codex Web GPT's embedded ChatGPT pages are never modified. An empty library is
valid and shows the add-wallpaper guide. Open Profile > Wallpapers in the official app to choose a
media item.

If the official app was already open without its wallpaper endpoint, the setting reports that a
one-time restart of the official app is required. Leave Codex Web GPT open while restarting the
official app, then the launcher attaches automatically. Users need a launcher build containing the
feature; updating or relaunching Codex Web GPT is sufficient when the toggle is missing.

### Account switcher

The Account switcher is available on Windows and reads the compatible Codex Switcher store at
`%USERPROFILE%\\.codex-switcher\\accounts.json`. Use **Add current account** to import the session
currently stored in the official Codex profile, then use **Switch and restart** on another account.
The launcher writes the selected account to `%USERPROFILE%\\.codex\\auth.json` and restarts only the
verified Microsoft Store Codex process when it was already running. If the official app is stopped,
the change applies on its next launch and no restart is needed.

Press **Refresh** on the Account switcher page to load the active account's ChatGPT usage windows,
rate-limit reset time, reset credits, and native token activity. The refresh uses the signed-in
account's ChatGPT session and stores only redacted usage metadata locally. An API failure is shown on
that account card and does not prevent switching accounts.

### ChatGPT shows `Error creating connector`

1. Confirm that the Tunnel ID and the regular API key used by the launcher were created under the
   same OpenAI account.
2. Confirm that the launcher has connected the local harness and the Tunnel is running before you
   create the connector in ChatGPT.
3. ChatGPT can reject the first **Create** attempt once even when the Tunnel is healthy, usually
   after 5–10 seconds. Press **Create** one more time. If the second attempt also fails, stop
   retrying and recheck the account, Tunnel ID, and running Tunnel first.

If tool calls work until native Codex quota is exhausted and then edits are denied by **Automatic
approval review**, disable that optional Codex review setting and restart Codex. Full automatic
mode now accepts the connector's one-shot **Allow once** prompt automatically, but the outer Codex
sandbox and native approval review still apply; this prevents an unavailable native model from
being inserted as an extra reviewer after the Web tool call already completed.

## `Reconnecting`, `stream disconnected`, or `ChatGPT failed`

These are result boundaries, not one diagnosis. The bridge uses them when it cannot prove a complete
ChatGPT turn. Common causes include an account-side rate limit, ChatGPT's own "Something went wrong"
state, a changed UI control, a closed browser surface, a conflicting route, or a tool that exceeded
its bounded MCP deadline.

- Read the final detailed error after the reconnect attempts; do not report only the word
  `Reconnecting`.
- Retry once in a fresh Codex task. State whether the fresh task works and whether the failure is
  consistent.
- Run **Settings → Run doctor** and export a safe log immediately after the failure.
- Include the exact model, Browser-only or Full harness mode, whether tools ran, and whether the
  ChatGPT page showed a final answer.

Do not assume that a generic 502 means the Tunnel is broken. Since v4.0.7, a native tool that
outlives its turn binding is reported explicitly as `codex_tool_timeout` and retired rather than
being presented as an ambiguous proxy success.

## Native compaction returns `404 Not Found`

For an ordinary Codex model, `/v1/responses/compact` forwards to the native legacy compact
endpoint. That endpoint can return an upstream 404 even when the model and authorization work.
Check whether a config layer sets `[features].remote_compaction_v2 = false`. Current Codex enables
V2 by default; remove that override or set the existing key to `true`, then restart Codex and retry
compaction on the same native model. V2 uses `/responses` with a compaction trigger.

If it still fails, include the effective feature setting, selected model, exact failure time and
safe log. `native_compaction_upstream_failed` records the route, model, HTTP status and available
request identifiers without prompt contents or credentials. A separate Web context-length error
still requires its own diagnosis; changing the native protocol does not increase Web input limits.

## ChatGPT says the account is temporarily limited

The bridge permits at most five simultaneous browser tabs as an account-safety ceiling. Five is not
a recommended concurrency setting, and ChatGPT does not expose a stable numeric quota or cooldown.
Some accounts have reached a limit with only two turns started close together.

After the first account-side limit response, stop retrying and let the cooldown clear. For a
conservative starting point, set one spawned agent thread at a time in the existing `[agents]`
section of `~/.codex/config.toml`:

```toml
[agents]
max_concurrent_threads_per_session = 1
```

If the table already exists, add or change only the key; do not create a second `[agents]` table.
If it contains `max_threads`, replace that old name with `max_concurrent_threads_per_session`;
do not keep both. Codex treats them as aliases and may reject the configuration as a duplicate field.
Bigger Context can make one turn larger and longer, but does not increase safe account concurrency.

## Images from earlier turns are attached again

Codex includes prior task images in the canonical conversation context. The bridge follows that
context and keeps only the newest ten complete images, so seeing an earlier image again in the same
task is expected. Start a new Codex task when the new request must not carry earlier image context.

Open an issue if the launcher reports that ChatGPT did not accept all attachments, or if images from
a different Codex task appear. Include a fresh safe log with the failing trace and attachment stage.
Do not replace inline images with arbitrary local paths: browser-only and compaction turns
intentionally do not receive unrestricted filesystem access.

## Image generation stops before an image appears

Image generation inside the ChatGPT browser conversation is not currently a supported turn type.
ChatGPT uses a separate generation lifecycle that the text-response bridge cannot reliably prove
complete or retrieve through its current contract.

Codex's native Image Gen tool uses a different path: it sends `/v1/images/generations` or
`/v1/images/edits` through the configured Codex base URL. The bridge forwards those requests to the
native Codex backend using the incoming Codex authorization. A local `404 Not found` on these paths
in 5.0.4 or earlier is a missing bridge route, not proof of an OpenAI plugin or backend failure.
Upstream authentication and image-allowance errors remain unchanged; the ChatGPT browser connector
does not provide credentials or additional allowance for native Image Gen.

## Update, repair, and remove

To update, quit **Codex Web GPT** and run the same installer command from the README. The installer
replaces the application and runtime while preserving the launcher configuration and private
ChatGPT profile.

On Linux, automatic updates require the installed launcher created by `install-launcher.sh`.
If Update reports that the stable wrapper is missing, quit the app, run the installer command
from the README, and reopen Codex Web GPT from the applications menu. This preserves settings and browser data.

To repair a valid integration, open **Setup → Install into Codex**, click **Reinstall** once,
and fully restart Codex. Avoid deleting configuration until **Run doctor** and a safe log identify
which layer failed.

To remove the integration safely:

1. Open **Settings → Remove Codex integration** and wait for it to restore the previous Codex route.
2. Fully restart Codex.
3. Quit the launcher and uninstall the application normally for the platform.
4. If Full harness was configured and is no longer wanted, separately delete **Codex Native2**, its
   Tunnel, and the API key created for that Tunnel from the corresponding account settings.

Deleting the application before step 1 can leave Codex pointed at a local route that no longer
exists.

## Open a useful bug report

Use the repository's bug-report form and attach the privacy-safe export from **Activity → Export
safe log**. A useful report contains:

- launcher version and installation method;
- Codex Desktop and/or CLI version;
- OS and architecture;
- ChatGPT account tier;
- Browser-only, Full harness (automatic), or Zero Risk mode and the exact selected model;
- For Zero Risk, the ChatGPT model/effort and the last completed step: copying, pasting, sending in ChatGPT, confirming Sent, or the first MCP call;
- exact reproduction steps and complete final error;
- whether it reproduces in a fresh Codex task; and
- a safe log captured immediately after that reproduction.

Screenshots are welcome, but a screenshot without the exact error and fresh log is usually not
enough to distinguish setup, routing, browser DOM, account, and MCP failures.

Before uploading anything, read [SECURITY.md](SECURITY.md). Never publish raw launcher logs, cookies,
browser storage, API keys, Tunnel IDs, full Codex prompts, tool output containing private data, or
absolute private paths.
