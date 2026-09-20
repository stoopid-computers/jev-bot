# jev-bot

Control native Mac apps from Codex or ChatGPT desktop through JavaScript that
remembers its variables between calls. Use element numbers for exact actions,
or let TypeSafe Jev choose a control from a description.

Package name: **`@compootor/jev-bot`** on npm and JSR. Both builds run in
Node.js 22+ or Bun 1.4.2+. Native desktop control requires macOS.

[Quick start](#quick-start) · [Usage](#usage) · [API reference](#api-reference) ·
[Configuration](#configuration) · [Troubleshooting](#troubleshooting) ·
[Development](#development) · [Releases](#releases) · [Attribution](#attribution-and-license)

Version **0.1.3** adds screenshot-based clicks, typing, scrolling, cursor movement,
explicit window activation, and keyboard shortcuts. Accessibility reads and
numbered controls remain available alongside visual input.

Visual methods require Cua Driver to advertise the matching window, coordinate,
and background-input contracts. Unsupported drivers return an error before input.
The independent hover cursor was tested with a patched local CuaDriver build;
those native patches and the compact cursor theme are installed separately.
See [visual usage](#use-screenshot-coordinates) for the workflow and limitations.

Browser tab/DOM APIs, dragging, clipboard paste, and app launching remain
unimplemented.

## Quick start

You need **macOS**, **Node.js 22+**, and a local MCP client such as Codex.
MCP is the connection that lets your agent call this tool. A
[TypeSafe API key](https://docs.typesafe.ai/sdk/javascript) is needed only for Jev
actions. Reading state and acting on element numbers work without it.

### 1. Install Cua Driver and grant access

If Cua Driver is already installed, skip the installer. Otherwise, use the
[official Cua installer](https://github.com/trycua/cua#readme):

```sh
/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
```

Run the permission setup and approve **Accessibility** and **Screen Recording**
in macOS. These permissions belong to Cua Driver, even if Codex already has them.

```sh
/Applications/CuaDriver.app/Contents/MacOS/cua-driver permissions grant
/Applications/CuaDriver.app/Contents/MacOS/cua-driver permissions status --json
```

Continue when both `accessibility` and `screen_recording` are `true` and
`source.attribution` is `driver-daemon`. See [troubleshooting](#troubleshooting)
if the status is `unknown`.

### 2. Install and configure

Install a published version from npm. For an unreleased checkout, follow
[Build from source](#build-from-source) instead.

```sh
npm install --global @compootor/jev-bot
mkdir -p "$HOME/.config/jev-bot"
touch "$HOME/.config/jev-bot/.env"
```

To enable Jev, edit `~/.config/jev-bot/.env` and set `TYPESAFE_API_KEY` to your key.
Keep the key out of chat and tool arguments.

```sh
jev-bot doctor --env-file "$HOME/.config/jev-bot/.env"
```

A successful check reports `driver: "connected"`, whether a key is configured,
and the available windows. It does not test the key or perform an action.

### 3. Connect your agent

Register the installed command with Codex:

```sh
codex mcp add jev-bot -- "$(command -v jev-bot)" \
  --env-file "$HOME/.config/jev-bot/.env"
codex mcp get jev-bot
```

Restart the client's MCP connection. You should see two tools, `js` and `reset`.
The client starts the server for you; you do not need a separate `npm start` process.

ChatGPT desktop and Codex clients on the same host share this configuration.
You can also add a **STDIO** server in ChatGPT desktop's **Settings → MCP servers**
using the absolute `jev-bot` path as the command and `--env-file` plus the absolute
environment-file path as its arguments. See
[OpenAI's MCP setup guide](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

ChatGPT web requires a remote integration. This project provides a local server;
it does not include a web gateway.

### 4. Try a read-only request

Ask your agent:

> Use jev-bot to list my open apps and windows. Don't change anything.

The agent should call `js` with `await cua.getState();` and receive the inventory
plus API guidance. To verify typing and clicking, use the [native smoke test](#native-smoke-test).

## Usage

The JavaScript below runs inside the MCP **`js` tool**, not your terminal or a
standalone Node script. Your agent plans the task and supplies the exact text.
Jev selects among actions supported by the observed controls; Cua Driver performs
the input on your Mac.

### Observe, act, then check

First, discover the apps:

```js
await cua.getState();
```

Open one TextEdit document yourself, then select it in a separate `js` call:

```js
let app = await cua.getApp("TextEdit");
```

This displays the window's accessibility state: the controls the app exposes,
with numbered rows, roles, labels, and values. `app` stays available in later
calls. For several windows, use `cua.getWindow(pid, windowId)` with the
`pid` and `window_id` from the inventory.

Use an actual editable element number from that output. Here `42` is an example:

```js
await app.setValue(42, "Draft text");
await app.getAXState();
```

`setValue` replaces the whole field. `typeText` inserts at the caret or selection.
After direct input, read fresh state before using another element number.
Support depends on what the app exposes through accessibility.

### Let Jev select a control

For a window with a Name field, select that app and describe the field:

```js
await app.setValue("Name field", "Sam");
await app.getAXState();
```

For several decisions toward one goal, use `act`. This example assumes the Name
field starts empty, since `act` with `text` offers insertion:

```js
let result = await app.act("Enter the supplied name in the empty Name field", {
  text: "Sam",
  expect: { role: "AXTextField", labelEquals: "Name", valueEquals: "Sam" },
  maxSteps: 2,
});
```

The result is displayed automatically. Check its `status` and `reason` before
continuing. Only an exact `expect` match can produce `verified`; a model deciding
that it is done does not prove success.

### Inspect visually or start over

```js
await app.getAXStateAndScreenshot();
```

This displays a screenshot and a fresh full accessibility read. The captures
happen in sequence. Jev receives text, while your agent interprets the screenshot.

Call the MCP **`reset` tool** with `{}` to discard variables and app selections.
It does not undo changes in the app.

### Use screenshot coordinates

Use version 0.1.3 or later and restart its MCP connection after upgrading. Your
agent reads screenshots and chooses each point; visual actions do not call Jev.

Select one running app and bring its window forward:

```js
let browser = await cua.getApp("Helium", { mode: "visual", activate: true });
```

This displays the initial screenshot and its pixel dimensions. If the app has
several titled windows, select one from `cua.getState()` using
`cua.getWindow(pid, windowId, { mode: "visual", activate: true })`.

In the next call, use a point observed in that screenshot. The coordinates below
are examples, not a target to reuse:

```js
await browser.click([420, 260]);
await browser.getScreenshot();
```

Use the **original PNG pixels**, even if your client displays a smaller preview.
Read and inspect a fresh screenshot after every action before choosing the next
point. Window input targets the selected window in the background and leaves the
hardware pointer in place. Browser-native tooltips can still appear beside the
hardware pointer because the browser shares macOS tooltip state. This native-only
implementation does not isolate that state.
An action receipt does not prove the intended change; uncertain input is never
automatically retried. See the [visual API reference](#visual-controls)
for shortcuts, typing, scrolling, and cursor configuration.

## API reference

All JavaScript methods are asynchronous. **Await every call and run UI actions
in sequence.** Discovery, observations, and actions display their own output;
do not wrap them in `nodeRepl.write` or `nodeRepl.emitImage`.
In the signatures below, `?` means optional.

### Embed in a Node or Bun application

Install from either registry in a project that uses `"type": "module"`:

```sh
npm install @compootor/jev-bot
# Or install the JSR distribution:
npx jsr add @compootor/jev-bot
```

```js
import { createSession } from "@compootor/jev-bot";

const session = createSession();
try {
  const output = await session.execute("await cua.getState();");
  console.log(output);
} finally {
  await session.close();
}
```

| Export or method                             | Purpose                                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `createSession({ driver?, choose? }?)`       | Creates a session. Optional `Driver` and `Choose` adapters support embedding and testing.                   |
| `session.execute(code, signal?, timeoutMs?)` | Returns MCP text/image content and an optional `isError` flag. Defaults to 30 seconds.                      |
| `session.reset()`                            | Clears JavaScript variables and app selections.                                                             |
| `session.close()`                            | Cancels active JavaScript, waits for native input to settle, and closes the connection. Safe to call again. |
| `createServer(session)`                      | Creates an MCP server; connect your own MCP transport and close the session when finished.                  |

Imports do not start a server, load `.env`, or contact the driver or model.
Configure environment variables in your application. Type declarations ship in
both packages. JSR provides the library and `/cli` entry, but no `jev-bot` command
shortcut. To start its MCP server from the consuming project:

```sh
node --input-type=module -e "await import('@compootor/jev-bot/cli')"
# Or run it with Bun:
bun -e "await import('@compootor/jev-bot/cli')"
```

Deno and browsers are not supported. Installing from JSR does not change the
runtime requirements or replace the native Mac driver.

Jev requests use [Effective Jev](https://github.com/stoopid-computers/effective-jev)
and Effect internally. The package configures Effect for you. The session API
still returns promises and uses the same API key and model settings.

### MCP tools

| Tool    | Input                           | Behavior                                                                                   |
| ------- | ------------------------------- | ------------------------------------------------------------------------------------------ |
| `js`    | `{ code, title?, timeout_ms? }` | Runs JavaScript and returns text/image output. Variables persist between calls.            |
| `reset` | `{}`                            | Clears variables and app selections. Wait for an active call to finish or cancel it first. |

`code` must contain 1 to 50,000 characters of nonblank JavaScript. `title` is an
optional description of 1 to 200 characters. `timeout_ms` defaults to `30000` and accepts
integers from `1` to `60000`. Only one `js` call can run at a time.

Ordinary JavaScript errors preserve variables. A timeout, cancellation, or crash
clears them. Input already sent to an app may have happened; select the
window and inspect it before continuing.

A read retries once with a fresh native connection only when its transport is
confirmed closed. Permission refusals do not trigger reconnects. Input and window
activation are never replayed automatically. `close()` is final.

### Find apps and windows

| Method                         | Returns             | Details                                                                           |
| ------------------------------ | ------------------- | --------------------------------------------------------------------------------- |
| `cua.getState({ emit? }?)`     | `{ apps, windows }` | Lists apps and windows. Use window `pid` and `window_id` to select a target.      |
| `cua.listApps({ emit? }?)`     | `{ apps }`          | App entries include `pid`, `name`, `running`, `active`, and optional `bundle_id`. |
| `cua.getApp(nameOrBundleId)`   | App handle          | Matches one running app by exact name or bundle ID. Requires one visible window.  |
| `cua.getWindow(pid, windowId)` | App handle          | Selects an exact window using positive integer IDs from the inventory.            |

An app handle is the object stored in `app` in the examples. In the default
accessibility mode, selection displays the initial full accessibility state.
Inventory calls display output by default; pass `{ emit: false }` to keep only
the return value.
Window entries include `pid`, `window_id`, `app_name`, `title`, and `is_on_screen`.
Select a visible window with a non-null `pid`.

### Visual controls

These methods are available in 0.1.3 and require matching Cua Driver capabilities.
Existing accessibility methods keep their behavior.

| Method                                                             | Returns               | Behavior                                                                                                                                                                                                            |
| ------------------------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cua.getApp(nameOrBundleId, { mode: "visual", activate: true })`   | Visual handle         | Selects one running app's single titled window, brings it forward, and displays a screenshot. Use an explicit window if ambiguous.                                                                                  |
| `cua.getWindow(pid, windowId, { mode: "visual", activate: true })` | Visual handle         | Selects and activates the exact observed window, then displays a screenshot.                                                                                                                                        |
| `visual.getScreenshot({ emit?, settleMs? }?)`                      | `Uint8Array`          | Displays a PNG and its original pixel dimensions; refreshes the frame used for input. `emit` defaults to `true`.                                                                                                    |
| `visual.move([x, y])`                                              | Receipt               | Hovers the selected window with the agent cursor, leaving the hardware pointer in place. Requires the patched local CuaDriver; confirm the visible result.                                                          |
| `visual.click([x, y])`                                             | Receipt               | Clicks once with the left button at the observed point.                                                                                                                                                             |
| `visual.typeText(text, { at: [x, y] })`                            | Receipt               | Clicks the observed field and inserts the supplied text at its caret or selection. Accepts 1–8,000 characters.                                                                                                      |
| `visual.pressKey(key)`                                             | Receipt               | Sends one key or chord, such as `Cmd+K`, to the exact window in the background. Requires a fresh screenshot. Desktop keyboard input is unsupported.                                                                 |
| `visual.scroll([x, y], direction, amount?)`                        | Receipt               | Scrolls at the observed point. Direction is `up`, `down`, `left`, or `right`; amount is an integer from 1 to 50, default 3.                                                                                         |
| `cua.getDesktop()`                                                 | Desktop visual handle | Displays the primary display for OS controls such as the menu bar. Supports `getScreenshot`, `click`, and `move`. Desktop movement changes the real pointer. Select a window when the cursor must stay independent. |

Selection options are `mode: "accessibility" | "visual"` and `activate: boolean`.
Defaults are accessibility mode and no activation. Visual handles support the
methods above; use an accessibility handle for element indices, `setValue`, or `act`.

Coordinates must be inside the latest screenshot and use its original PNG
pixels. Every action invalidates the captured frames. Call `getScreenshot()`
again before selecting another point. Your agent supplies visual targeting and
checks the result; Jev still selects only native accessibility actions.

Visual receipts distinguish refusal from uncertain delivery. A known refusal
reports `attempted: false`, `executed: false`, `execution: "not_attempted"`, and
`effect: "refused"`. Known driver errors include a safe `code` and `recovery`
message. An uncertain attempt reports `attempted: true`, `executed: false`, and
`execution: "unknown"`. Inspect a fresh screenshot before continuing. No receipt
alone proves the requested UI change.

After a hover, capture waits until at least 100 ms have elapsed since the move
finished, giving the app time to paint. Time spent between calls counts toward
this interval. `settleMs` accepts integers from 0 to 1,000; use `0` to capture
immediately. Other actions add no such delay.

Configure motion through the same MCP session:

```js
await cua.configureCursor({
  glideDurationMs: 120,
  dwellAfterClickMs: 0,
  idleHideMs: 1500,
});
```

This changes only the connection's cursor and sends no input. Optional `themeId`
selects an already-installed Cua theme. Glide and click dwell accept 0–5,000 ms;
idle visibility accepts 0–60,000 ms. Zero glide uses the driver's speed-based
motion. The local alpha uses `com.compootor.jev.compact`, an approximately 23-point
adaptation of Cua's cursor. That theme and the patched native driver are not part
of the published package. Configure again after reconnecting.

Build local CuaDriver candidates with `--release`. On this Mac, optimized window
captures took 119–157 ms; the debug build took 5.15–5.21 seconds. These are local
samples, not a cross-machine performance guarantee.

For embedded adapters, `Driver` adds optional `activate`, `visualScreenshot`,
`visualExecute`, and `configureCursor` methods. The root exports `VisualTarget` for an exact window
or `{ displayId: "primary" }`, and `VisualAction` for move, click, text, scroll,
or exact-window key input.
Adapters without these methods retain accessibility support.

### Read a window

| Method                                  | Returns                                     | Options and behavior                                                                  |
| --------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------- |
| `app.getAXState(options?)`              | `string`                                    | Formatted accessibility rows. Later reads show changes unless `disableDiffing: true`. |
| `app.getScreenshot(options?)`           | `Uint8Array`                                | PNG bytes. Previous element numbers become invalid.                                   |
| `app.getAXStateAndScreenshot(options?)` | `{ state: string, screenshot: Uint8Array }` | Screenshot followed by a full accessibility read, which refreshes element numbers.    |

All three accept `emit`, default `true`. Accessibility reads also accept
`query`, a filter of up to 1,000 characters. Set `disableDiffing: true` on
`getAXState` to show all returned rows; the default is `false`.
The combined method always shows all returned rows.

### Click, enter text, and press keys

| Method                            | Uses Jev? | Returns / behavior                                                                       |
| --------------------------------- | --------- | ---------------------------------------------------------------------------------------- |
| `app.click(index)`                | No        | Receipt. Clicks an enabled native control that advertises `AXPress`.                     |
| `app.click(description)`          | Yes       | Run result. Uses at most one decision to choose a control.                               |
| `app.setValue(index, text)`       | No        | Receipt. Replaces the whole editable field, including with `""`.                         |
| `app.setValue(description, text)` | Yes       | Run result. Uses at most one decision to choose a field and replace its value.           |
| `app.typeText(text)`              | No        | Receipt. Inserts into the editable field last selected by numeric `click` or `setValue`. |
| `app.pressKey(key)`               | No        | Receipt. Sends one supported key to the selected window.                                 |

`index` is a number from the latest accessibility read. `description` is a
nonempty string of up to 8,000 characters; `text` allows up to 8,000 characters.
Editable roles are `AXTextField`, `AXTextArea`, `AXSearchField`, and `AXComboBox`.
Password fields and controls inside web content are excluded.

Direct input invalidates element numbers. Jev methods read state themselves and
return the latest observation when available. `typeText` rereads its selected
field and requires a unique role/label match. Jev calls and focus-changing keys
clear that selection. Caret movement and deletion preserve it, including Shift
and Option modifiers, so you can move the caret and continue typing.

Supported keys: `return`, `tab`, `escape`, `space`, `backspace`, `delete`, `up`,
`down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`.
Direct `pressKey` also accepts letters, digits, F1–F12, and chords such as
`Cmd+K` or `Cmd+Shift+S`. Modifiers are Cmd, Ctrl, Option, Shift, and Fn;
Command/Meta, Control, and Alt are aliases. Enter and Esc alias Return and Escape.
Names ignore case. Pass one key or chord per call, not a sequence. Direct shortcuts
are available in 0.1.3. Jev's `act({ keys })` remains limited
to the lowercase navigation/editing list above.

### Work toward a goal

`app.act(goal, options?)` returns a run result. `goal` must be nonblank and at
most 8,000 characters.

| Option          | Default | Meaning                                                                                                      |
| --------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `text`          | None    | Exact text available for insertion, up to 8,000 characters. Jev does not generate text.                      |
| `keys`          | `[]`    | Up to 16 keys Jev may choose from. Use lowercase names from the supported list.                              |
| `expect`        | None    | Exact conditions for reporting success. See below.                                                           |
| `maxSteps`      | `4`     | Decision limit, an integer from `1` to `8`. Choosing to read state again also uses a step.                   |
| `minConfidence` | `0.7`   | Minimum accepted Jev confidence, from `0` to `1`. This default is not a measured desktop accuracy guarantee. |
| `query`         | None    | Filter accessibility reads, up to 1,000 characters. Useful for large windows.                                |

`expect` accepts `role`, `labelEquals`, and `valueEquals`. All supplied conditions
must match exactly. Select a field with `role` or `labelEquals`, then check its
value with `valueEquals`; a nonblank `labelEquals` alone can check for a label.
`role` alone is insufficient. If the selector matches several returned elements,
the tool asks the agent to take over instead of claiming success.

### Understand results

Direct actions return a **receipt** with `executed`, `effect`, and optional
`delivery` or `stale` fields. Interrupted input can instead include `outcome`
and `reason`. `executed: false` means the effect was not confirmed; it does not
guarantee that no input occurred.

Jev methods return `{ status, reason, history, observation? }`:

| Status             | What to do next                                                                      |
| ------------------ | ------------------------------------------------------------------------------------ |
| `verified`         | The supplied `expect` matched one returned element. Continue based on that evidence. |
| `handoff`          | Read `reason`; provide missing information or choose another way to act.             |
| `unknown`          | Inspect fresh state before taking another action. The outcome is uncertain.          |
| `budget_exhausted` | Review the latest state; the decision limit was reached.                             |
| `cancelled`        | The loop stopped before another input. Inspect any earlier actions.                  |

`history` records decisions and attempted actions. `observation` contains
`target: { pid, windowId }`, `snapshotId`, `appName`, `windowTitle`, `elements`,
`complete`, and `degraded`. Elements include `index`, `role`, `actions`, and
optional `label`, `value`, and `enabled` fields.

Description-based `click` and `setValue` accept no `expect`, so they cannot report
`verified`. Inspect their returned observation. Mac accessibility reads are
partial: finding a value does not prove that an external task, such as saving
to a server, succeeded. Uncertain input is never automatically retried.

### Display your own output

| Method                            | Behavior                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `await nodeRepl.write(value)`     | Displays text. Objects use a readable inspection format. Use `JSON.stringify(value)` for JSON. |
| `await nodeRepl.emitImage(bytes)` | Displays PNG bytes as an image; accepts a `Uint8Array` up to 8 MB.                             |

Each call allows up to 32 output blocks and 100,000 characters per text block.
Use `emit: false` when collecting several observations without displaying each.

## Configuration

The CLI accepts `--env-file /absolute/path/.env`. Without that option, it looks
for `.env` beside the package's `dist` directory, which supports local development.
Inherited environment variables take precedence. Library imports do not load
environment files. Restart the MCP connection after configuration changes or rebuilding.

| Variable                 | Default                                        | Purpose                                         |
| ------------------------ | ---------------------------------------------- | ----------------------------------------------- |
| `TYPESAFE_API_KEY`       | Unset                                          | Enables description-based actions and `act`.    |
| `TYPESAFE_DEFAULT_MODEL` | `jev-1.13.0`                                   | TypeSafe model used for decisions.              |
| `CUA_DRIVER_BIN`         | Installed Mac app, then `cua-driver` on `PATH` | Absolute path to a different driver executable. |

Each Jev request has an eight-second timeout and no automatic retries. Cancelling
the call aborts its active request.

Jev requests send the selected window's accessibility text, your goal, available
action descriptions, and recent decisions to TypeSafe. Text you enter can appear
in later accessibility reads. Screenshots go to your agent, not Jev. Recognized
password fields are excluded; other sensitive app content can still be sent.
Use this tool with trusted agents. Its JavaScript session is not a security
sandbox for untrusted code.

## Troubleshooting

| Problem                                            | Next step                                                                                                                                                   |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Permissions are `unknown` or `permissions_pending` | Run `permissions grant` from step 1 and approve both macOS grants. `unknown` means the driver cannot yet verify its permissions under its own app identity. |
| Driver cannot connect                              | Run `/Applications/CuaDriver.app/Contents/MacOS/cua-driver doctor`. Check the installation or set `CUA_DRIVER_BIN`.                                         |
| Jev returns `handoff` before acting                | Read `reason`. Check the key, network access, and model setting; confirm the window exposes a supported control.                                            |
| An element number is stale                         | Run `app.getAXState()` and choose the number from the new read.                                                                                             |
| App or window selection is ambiguous               | Use `cua.getState()`, then `cua.getWindow(pid, windowId)` with one observed window.                                                                         |
| A window or response is too large                  | Narrow the read or `act` call with `query`.                                                                                                                 |
| A call timed out or was cancelled                  | Select the app again and inspect it. Input may already have occurred.                                                                                       |
| The client still uses an old build or path         | Rebuild, rerun the registration command from the project directory, and restart the MCP connection.                                                         |

## Development

### Build from source

Use Node 22.18+, 24.11+, or 26+ for development. The published runtime supports
Node 22+ and Bun 1.4.2+. From the repository directory:

```sh
npm ci
npm run build
test -f .env || cp .env.example .env
node dist/cli.js doctor
codex mcp add jev-bot -- "$(command -v node)" "$PWD/dist/cli.js"
```

Add `TYPESAFE_API_KEY` to `.env` before using Jev. The build generates the server
version from `package.json`; do not edit `src/version.ts` or `dist`.

tsdown builds the JavaScript and declarations. TypeScript 7 uses Effect's TSGo
patch for typechecking; `npm ci` applies that patch and the matching Oxlint patch
through the `prepare` script. Keep TypeScript, `@effect/tsgo`, Oxlint, and
`oxlint-tsgolint` at compatible versions when upgrading.

The older `typescript-api` development alias supplies the syntax-tree API used
to prepare JSR imports. It does not compile the project.

[ts-reset](https://www.totaltypescript.com/ts-reset) applies only during development
through `types/ts-reset.d.ts`. It is
excluded from both packages and never changes a consumer's global types.

Oxlint uses [Effect's correctness preset](https://github.com/Effect-TS/tsgo/blob/main/docs/README.md)
with type-aware checks. CI runs the same format, lint, and type checks before
testing or publishing.

### Editor setup

In Zed, enable the **Effect Language Service (tsgo)** and **Oxc** extensions.
The workspace selects Effect's TSGo server, Oxlint diagnostics, and Oxfmt on save.
In VS Code, install the workspace's recommended **TypeScript Native Preview**
and **Oxc** extensions and use the workspace TypeScript version.

Effect diagnostics come from Oxlint; the language service keeps completions,
navigation, and fixes without reporting those diagnostics twice. Restart the
language servers after installing or upgrading dependencies.

### Offline checks

```sh
npm run check
```

`check` runs formatting, type-aware linting, typechecking, and offline tests.
Use `npm run format` to format files and `npm run lint:fix` for safe lint fixes.
Each check also has its own command: `format:check`, `lint`, `typecheck`, and `test`.

Tests rebuild the package and check the SDK contract, MCP transport, persistent
JavaScript, native driver adapter, stale state, and cancellation. They do not
control apps or make paid model requests.

Check the actual packages before releasing. The JSR check requires Deno:

```sh
npm run package:check
npm run jsr:check
```

The package check inspects the npm archive, installs it in a temporary project,
and tests imports, the worker, and MCP. It stages npm and JSR artifacts in
`.release/`. Only compiled runtime files, types, package metadata, this README,
`LICENSE`, and `NOTICE` are published. Credentials, test fixtures, and local
artifacts are excluded.

Run `npm start` to start the local MCP process manually. It waits for protocol
input from a client. Use `node dist/cli.js doctor` for a readable setup check.

### Native smoke test

With the key and permissions configured, run:

```sh
npm run build
npm run smoke:live -- --live
```

This requires Apple's Command Line Tools for the Swift compiler. It opens a
disposable native form, asks Jev to replace one field and click Submit, then
checks the exact value and a single click through a separate receipt file.
It closes its own form and writes results under `.local/native-smoke/`.

A full run makes two paid Jev requests. It never retries input. Without `--live`,
the command skips without opening an app or calling TypeSafe.

<details>
<summary>Validation recorded on 2026-09-19</summary>

- Typecheck, build, and all 120 offline tests passed, including a real MCP stdio connection. CI also checks Node 22.
- Bun 1.4.2 passed all eight test files, including persistent JavaScript, cancellation, and the MCP stdio connection. CI repeats these checks on macOS before publishing.
- The npm archive passed a clean-install check. The JSR package passed its publication dry run. Version `0.1.0` was published through GitHub Actions to both registries, with its archives and file manifest verified.
- Cua Driver 0.28.2 was installed with its published checksum and app signature verified.
- One live `jev-1.13.0` request through Effective Jev selected the expected action from synthetic window data. It performed no desktop input. No desktop performance benchmark has been run.
- The smoke runner passed TypeScript checking; its Swift fixture passed compiler typechecking.
- A fresh Codex CLI session using published `0.1.2` replaced a native fixture field, clicked Submit, and captured its screenshot. An independent receipt confirmed the exact text and one click. Stale-index rejection and reset worked; Jev selection and window recovery did not complete. See the [computer-use review](https://github.com/stoopid-computers/jev-bot/blob/release/0.1/COMPUTER_USE_REVIEW.md) for measured results and limitations.
- The 0.1.3 candidate completed hover, search, thread selection, scrolling, a theme change, new-chat creation, and prompt submission in Helium through the custom MCP. One capture interruption needed explicit window recovery. These tests used a patched local native driver; they do not prove an uninterrupted recorded demo or stock-driver parity. ChatGPT desktop invocation remains unverified.

</details>

## Releases

Publish only from **`release/<major>.<minor>`** branches. Development can happen
elsewhere; `main`, `staging`, and `dev` cannot publish. All package manifests and
the server's reported version stay in sync.

| Example               | Branch        | npm channel                                        |
| --------------------- | ------------- | -------------------------------------------------- |
| `0.1.1`               | `release/0.1` | `latest`, unless a newer version is already latest |
| `1.0.0-rc.1`          | `release/1.0` | `next`, unless a newer candidate is already next   |
| `0.1.2` after `1.0.0` | `release/0.1` | `release-0.1`, preserving the newer latest         |

Use patch versions for compatible fixes, minor versions for compatible features,
and major versions for breaking changes. Before `1.0.0`, breaking changes increase
the minor version. Candidates use `-rc.N`; other prerelease labels and build
metadata are intentionally unsupported. A published version or tag is never reused
for different code.

### Prepare a version

Start with a clean, committed checkout on the matching release branch:

```sh
git switch release/0.1
npm run release:prepare -- 0.1.1
```

The command updates `package.json`, `package-lock.json`, and `jsr.json`. It does
not commit, tag, push, or publish. Review the changes, commit them, and push the
release branch. To release the already-prepared initial `0.1.0`, use
`npm run release:check -- 0.1.0` instead of incrementing it.

In GitHub Actions, run **Release**, select the matching release branch, and enter
the exact version. The workflow checks Linux and macOS, builds and tests the
packages from that commit, reserves `v<version>`, and publishes to npm and JSR.
It creates the GitHub release only after verifying both registry versions.

If one registry or asset upload fails, rerun the same workflow run at the same
commit. Existing packages must match the built bytes before the workflow continues.
For code changes, prepare a new version. Downloaded release artifacts include the
npm archive and a receipt recording the source commit and registry checksums.

<details>
<summary>Maintainer setup and first publication</summary>

1. Push the workflows to the repository's default branch so GitHub can display
   the manual Release workflow. Create and push `release/0.1` from the reviewed
   commit for the initial version. Protect release branches and `v*` tags against
   force pushes and deletion.
2. Create a GitHub environment named `publish`, restricted to `release/*` branches.
   Add required reviewers if releases should need a final approval.
3. Create the `@compootor` scopes and confirm publisher access on both registries.
   On JSR, create `@compootor/jev-bot` and link it to
   `stoopid-computers/jev-bot` in the package settings.
4. npm requires an existing package before configuring trusted publishing. For
   the first version, create a short-lived granular npm token. Under **Packages
   and scopes**, grant **Read and write (publish and stage)** to `@compootor` and
   enable **Bypass two-factor authentication** for unattended publishing. Leave
   organization-management access at **No access**. Save the token yourself as
   `NPM_TOKEN` in GitHub's `publish` environment. Do not put it in chat or `.env`.
5. Dispatch **Release** from `release/0.1` with version `0.1.0`. The workflow
   makes the token available only to the publication step, after its checks pass.
   JSR uses GitHub OIDC and needs no token.
6. After npm publishes the first version, open its trusted publisher settings.
   Enter organization `stoopid-computers`,
   repository `jev-bot`, workflow filename `release.yml`, and environment `publish`.
   Allow direct publishing. Remove `NPM_TOKEN` from the GitHub environment and
   revoke the temporary token on npm. If the workflow stopped after npm
   succeeded, rerun the same workflow run to finish JSR and the GitHub release.

Without a bootstrap token, the first workflow run stops at npm authentication
and retains its verified tarball as an artifact. Download that exact file and
publish it interactively with an authorized npm account:

```sh
npm publish /path/to/compootor-jev-bot-0.1.0.tgz --access public --ignore-scripts
```

Then configure trusted publishing as above and rerun the same workflow run.

Later releases use short-lived GitHub OIDC credentials. No long-lived npm or JSR
publish token is needed. A successful new-version release without `NPM_TOKEN`
verifies npm trusted publishing; rerunning an existing version does not. The
native driver and TypeSafe key are also unnecessary for the release checks.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[npm first-publish prerequisite](https://docs.npmjs.com/cli/v11/commands/npm-trust/),
[npm token permissions](https://docs.npmjs.com/creating-and-viewing-access-tokens/),
[JSR GitHub publishing](https://jsr.io/docs/publishing-packages), and
[GitHub manual workflow requirements](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch).

</details>

## Attribution and license

jev-bot builds on **Cua Driver by Cua AI** for native desktop observation and
input. Its action selection draws on [CUA's Jev example](https://github.com/trycua/cua/tree/bdaf8c2570e35254f5e50a317781374efe7aa91a/libs/cua-driver/examples/jev-use)
and [jev-ultrafast by Browser Use](https://github.com/browser-use/jev-ultrafast).
[Effective Jev](https://github.com/stoopid-computers/effective-jev) provides the
runtime Jev client. It is an independent Effect-based fork of the
[TypeSafe JavaScript SDK](https://github.com/typesafe-ai/typesafe-sdk-js),
originally authored by [evinism](https://github.com/evinism).

This is an independent integration. [Cua Driver](https://github.com/trycua/cua/tree/main/libs/cua-driver)
is installed separately. jev-bot's code is [MIT licensed](LICENSE); upstream
credits, copyright notices, and MIT license text are retained in [NOTICE](NOTICE)
and ship with both registry packages.
