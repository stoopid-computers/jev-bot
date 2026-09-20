# Computer-use review

The local candidate now completes the requested browser interactions through
jev-bot: hover, search, thread selection, scrolling, theme change, new chat and
prompt submission. A capture interruption required explicit window recovery, so
this is not yet proof of an uninterrupted recorded demo. This report records testing before the 0.1.3 release.

The baseline below describes published 0.1.2. The final section records subsequent
local fixes, measured results, and remaining limits.

## Baseline and evidence

Tested on **2026-09-19**, using `@compootor/jev-bot@0.1.2`, commit
`d4be4a3bffe22704a1a9adc49ac044c61e9ee673`, Codex CLI `0.155.0`, Node `26.7.0`,
and macOS `26.6.2`. A fresh Codex process called the package's actual `js` and
`reset` MCP tools. These were native desktop tests, separate from the earlier
synthetic Jev request and offline tests.

Default CUA was used only for setup and comparison before the user's later
prohibition. The fixture required the upstream driver's explicit `bring_to_front`
for setup before this package had a visual activation API. The measured fixture
operations below used jev-bot through Codex. This baseline does not claim a
completed Helium browser/chat demonstration.

Evidence was recorded under `.local/computer-use-audit/`. The screenshots,
recordings, temporary scripts, and logs were deleted during the requested
cleanup. The paths below identify the original evidence; those files are no
longer available. Measurements in this report are retained as a written record:

- `environment.json` records the version and environment.
- `codex-fixture-foreground-events.jsonl` contains the measured MCP calls.
- `receipt.json` confirms `codex-native-direct-01` and `clickCount: 1`.
- `codex-fixture.png` shows the field and submitted status.
- `raw-fixture-observation.json` preserves the degraded driver response.
- `stale-connection.json` records failure after the native daemon restarted.
- `codex-textedit-events.jsonl` and `custom-session-events.jsonl` record the
  blocked TextEdit and initial Helium observations.

The deleted raw traces contained local desktop metadata and were never tracked.

| Test                                     | Result                               | Evidence and limits                                                                                                         |
| ---------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Numeric field replacement                | Passed                               | Exact value read back; 2,534 ms.                                                                                            |
| Numeric Submit click                     | Input passed; confirmation ambiguous | One independent receipt; 2,501 ms. Tool returned `executed:false`.                                                          |
| Screenshot                               | Passed                               | Correct fixture and submitted status; 153 ms.                                                                               |
| Screenshot invalidates indices           | Passed                               | Old index rejected without input; fresh read succeeded in 37 ms.                                                            |
| Jev field selection                      | Did not complete                     | One request, 1,147 ms; invalid/low-confidence handoff, empty history, no mutation.                                          |
| Insert text                              | Input occurred                       | `abc` became `X`; caret/selection was not independently measured.                                                           |
| Move caret, then type                    | Blocked                              | `pressKey("left")` cleared the typing target; following `typeText` rejected.                                                |
| `Cmd+S`                                  | Unsupported as documented            | Rejected before input.                                                                                                      |
| Reset                                    | Variables cleared; recovery failed   | `app` became undefined; exact-window reselection failed.                                                                    |
| TextEdit and initial Helium access       | Blocked                              | Inventory worked; exact-window observation returned an invalid-string error. No document editing or browser task completed. |
| Multi-step verification and cancellation | Not completed                        | No native end-to-end evidence from this run.                                                                                |

Times measure individual operations inside the tool call. They exclude model
thinking and reporting delays. They are samples, not benchmarks.

## 1. Bad UX

**P1: A successful click looks like failure.** Submit returned
`executed:false, effect:"unverifiable"` despite the independent receipt and
screenshot. The driver reports uncertain confirmation, not failed delivery.
The README explains this distinction, but the boolean's name invites an unsafe
retry. Separate attempted delivery from confirmed effect.

**P1: Ordinary editing has no clear path.** Reproduce with
`setValue(index,"abc")`, `pressKey("left")`, then `typeText("Y")`.
The last call demands another `setValue`. Clicking the field cannot select it
because its advertised actions omit `AXPress`. Add explicit field focus or
indexed insertion. The observed `abc` → `X` replacement alone is not a data-loss
bug: insertion is documented to replace the current selection.

**P2: Recovery guidance is too generic.** The shortcut error dumps a validation
enum. Jev's response combines invalid decisions and low confidence without
revealing which occurred. Provide concise reasons and the next supported action.

## 2. Bugs

**P1: A valid degraded response becomes an invalid-string error.** Reproduce by
selecting the unresolved fixture window. The saved driver response has
`degraded:true`, no elements, and no `snapshot_id`. `normalizeObservation`
requires that string before interpreting degradation. Offline replay confirms
the failure. Report unavailable exact-window accessibility without fabricating
actionable state.

**P1: Daemon restart breaks the existing connection.** A subsequent read-only
`getApp` returned "Driver request failed; its outcome is unknown." A fresh MCP
connection restored discovery. Reconnect safely after transport loss; never
replay an uncertain mutation.

**P2: Large values reject the entire observation.** An offline adapter check
accepted an 8,192-character value and rejected 8,193 characters. Native long
document behavior remains untested. Truncate read-only content explicitly or
return a useful size error.

## 3. Unoptimized flows

- Simple native mutations took roughly 1.0–2.5 seconds; fresh accessibility reads
  took 23–47 ms. Investigate native delivery overhead before making speed claims.
- Screenshot and direct-action invalidation require extra reads. Preserve the
  freshness checks, but make supported action sequences easier to express.
- The tiny form exposed 24 actionable rows, largely window/menu controls, while
  omitting its useful status text. Improve observation relevance.
- A long-lived MCP process does not load rebuilt code automatically. Connection
  recovery also needs a distinct path from resetting JavaScript variables.

## 4. Missing features

**P1: Read-only feedback is invisible to Jev.** Static labels and submitted status
exist in the upstream tree and screenshot but are absent from structured
`elements`. The adapter consumes only those elements. Consequently, `expect`
cannot verify the fixture's status. Add separate read-only observation content
without turning display text into action targets.

Version 0.1.2 also lacks cursor coordinates, explicit window activation, browser
tabs/navigation, scrolling, dragging, shortcuts, clipboard paste, and app
launching. Screenshots alone cannot provide the requested browser interaction
or recording-stop workflow.

## 5. Overall assessment

The package proves native input through Codex on a prepared form. Stale-index
rejection and refusal to retry uncertain input worked. It does not yet prove
reliable autonomous desktop work or parity with Codex CUA. One rejected live
Jev request cannot establish model accuracy. Fix observation and recovery first,
then test complete tasks across native apps and browsers.

## Local candidate, 2026-09-20

The JavaScript API changes are included in 0.1.3. The native changes remain local
and live separately
in `../cua/libs/cua-driver/rust/crates/platform-macos/`. Tests use
`/Applications/CuaDriverLocal.app`; the released CuaDriver installation is intact.
Only the custom jev-bot MCP was used for these interactions.

| Finding                                                  | Change                                                                                 | Evidence                                                                                                                                                                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Captures stall for about five seconds                    | Install an optimized native build with `--release`                                     | Same Helium window: debug 5,153/5,212/5,207 ms; optimized 157/122/119 ms.                                                                                                                                             |
| Hover moves the hardware pointer                         | Exact-window hover posts to the target PID and moves only the agent overlay            | Six moves with hardware position unchanged at `(1094, 612)` before and after. Each input took 179–201 ms, including 120 ms motion.                                                                                    |
| A delivered hover returns `action_outcome_mismatch`      | Native hover now returns an explicit execution record                                  | Real custom MCP hover receipts report background delivery with an unverifiable effect, without inventing confirmation.                                                                                                |
| Immediate screenshot sometimes shows the previous hover  | Capture waits until 100 ms after hover completion, paying only the remaining interval  | Live 0/50/100/150 ms probe caught a stale frame at 0 ms. REPL regression checks the default wait and explicit opt-out. Combined live hover/capture checks passed in 453 and 498 ms with the correct highlighted rows. |
| No keyboard shortcuts in visual mode                     | Add exact-window `pressKey`, chord parsing, and fresh-frame enforcement                | Cmd-K opened search in 1,211 ms; Escape closed it in 1,241 ms, including capture.                                                                                                                                     |
| Caret movement loses the native typing target            | Preserve the target for caret/delete keys; clear it for focus-changing shortcuts       | Behavioral regression passes. Native fixture recheck remains pending.                                                                                                                                                 |
| Closed transport breaks all later reads                  | Reconnect once for a read after confirmed transport closure                            | Fault-injection tests pass. Input, activation, and permission refusals are not retried. Live transport-loss check remains pending.                                                                                    |
| Cursor label and movement settings require private setup | Shorten generated labels and expose `cua.configureCursor`                              | Real REPL regression passes. The local compact theme is about 23 points, with 120 ms glide, no click dwell and 1.5 second idle visibility.                                                                            |
| Activation rejects Helium's fullscreen toolbar           | Exclude a contained, untitled same-process compositor surface only with fresh AX proof | Old selector failed the targeted test; all nine activation tests pass with the fix. Exact live activation passed from another app/Space in 678 ms, including the first screenshot.                                    |

Two moves and three captures completed in one custom MCP call in 812 ms before
the new paint interval. This measures tool execution, not model deliberation or
the total time between tool calls. Faster native calls alone cannot guarantee a
continuous demonstration.

The activation investigation also found an overlay left by an older test daemon.
That daemon was stopped. The new selector still respects independently mapped
sibling windows, other processes, and surfaces outside the requested window.
It does not treat an accepted activation request as proof of focus.

### Remaining limits

**Native browser tooltips are still shared.** Hovering the first thread produced
"A quieter internet" near the hardware pointer despite the pointer staying
stationary. The screenshot OCR regression catches that exact symptom. Chromium's
macOS tooltip bridge uses the real pointer position; the tooltip text is not part
of Jev's overlay. The user chose to keep jev-bot native-only. No browser adapter,
page modification, or claim of tooltip isolation is included.

The tooltip evidence is `custom-1789814227207-13-0.png` and `tooltip-probe.swift`.
Relevant upstream implementation is Chromium's
[`ToolTipBaseView`](https://chromium.googlesource.com/chromium/src/+/main/ui/base/cocoa/tool_tip_base_view.mm)
and
[`RenderWidgetHostNSViewBridge`](https://chromium.googlesource.com/chromium/src/+/main/content/app_shim_remote_cocoa/render_widget_host_ns_view_bridge.mm).

**The workflow works, with one recovery interruption.** The latest custom MCP
run selected the last search result, reached its final response and composer,
changed theme, started a chat, entered the exact Bun/Elixir prompt and submitted
it. During submission, a foreground change coincided with ScreenCaptureKit
failure. Exact-window reselection restored capture; the screenshot showed an
unsent draft before a new submission attempt. No unknown input was blindly
replayed. An uninterrupted timed run remains unproven.

The page was on its Index variant during the test. No URLs were typed. This is a
design prototype: the response to the BEAM request was the same canned circles
example, not generated Bun/Elixir code. No Projects or Artifacts interactions
were performed.

**Local rebuilds require permission work.** This Mac has no configured signing
identity, so the local installer uses ad-hoc signing. Native code changes can
invalidate macOS grants. After the user approved the activation candidate, a fresh LaunchServices probe
and then the daemon both confirmed Accessibility and Screen Recording. The
subsequent click/keyboard build changed the signature again, and a fresh app probe
initially confirmed both grants inactive. After renewal, the running daemon
confirmed both grants active and live tests resumed. The CLI's status command
also misreports the blocked daemon as absent; direct calls report the gate.

Recording capabilities are unchanged and remain under the user's control. The
recorded demo is paused until their cue. Desktop pointer movement is excluded
from the independent-cursor tests.

### Validation and evidence

At the time of the native tests, `npm run check` passed formatting, lint,
typechecking, and all 146 Node tests. All 101 selected Bun tests passed.
`npm run package:check` passed installed-package
imports, consumer declarations, worker lifecycle, CLI and MCP handshake checks.
The native hover and activation regressions passed before installation. Full
cross-platform certification has not been run; these are experimental macOS
changes. That test session did not commit, push, tag, or publish them.

Additional evidence originally recorded under `.local/computer-use-audit/`,
since deleted during cleanup:

- `hover-latency.json` and `hover-wait-*.png` record movement, paint timing and
  unchanged hardware pointer coordinates.
- `custom-session-events.jsonl` and `native-demo-actions.jsonl` preserve MCP
  execution and native receipts.
- `release-build.log`, `activation-test-red.log`, `activation-test-green.log`,
  and `activation-install.log` record native validation and installation.
- `final-check.log` records the current Node validation.

Raw screenshots and traces were excluded from Git because they contained desktop metadata.

### Input-route follow-up

Fresh custom MCP session `1789841953036` verified exact activation and two
post-hover captures. Hardware pointer coordinates remained `(835, 297)`.
Cmd-K opened search, but clicking Clear and the last result had no visible effect.
A later capture confirmed this was not just paint timing. Native receipts said
`route: "accessibility"` and "PX hit-test pressed the background element via AX".
The native AX observation still described the page behind the search dialog.

The local fix keeps coordinate clicks on PID-routed mouse events. Explicit
AX element actions retain their existing path. Focus-only pixel requests may
still use AX hit-testing. The fix also releases chord modifiers explicitly;
previously Cmd-K and Cmd-A left the page's Command-key hints visible until a
plain key was sent. Both are native changes, not browser adapters.

Before cleanup, the screenshot regression caught the old failure:

```sh
swift .local/computer-use-audit/search-selection-check.swift \
  .local/computer-use-audit/custom-1789841953036-10-1.png
# FAIL: selected thread did not replace the search dialog
```

The six existing native click tests and six keyboard tests pass. They do not
prove the browser symptom is fixed; the live screenshot regression is the
acceptance check. `input-fix-install.log` records the installed candidate.
No recordings, commits, or releases were made.

### Verified input candidate

Custom MCP session `1789843673055` exercised the rebuilt native driver after
both permissions were confirmed under its own identity.

| Check                                          | Result and elapsed time                                                                                  |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Exact window activation and capture            | Passed, 687 ms.                                                                                          |
| Cmd-K, including modifier release              | Passed, 1,225 ms; Command hints no longer remain visible.                                                |
| Last search result                             | Passed, 1,575 ms; modal closed and the expected generative-art thread appeared.                          |
| Scroll to final response and composer          | Passed, 3,227 ms for 50 wheel notches.                                                                   |
| Theme toggle                                   | Passed, 1,582 ms.                                                                                        |
| New chat                                       | Passed, 1,592 ms.                                                                                        |
| Exact 143-character prompt entry               | Passed, 7,842 ms; screenshot confirms the draft.                                                         |
| Submit                                         | Passed after explicit recovery, 1,565 ms; prompt appears in the thread and preview begins.               |
| Compact hover plus window and desktop captures | Passed, 539 ms; hardware pointer stayed at `(437, 229)`.                                                 |
| Search Clear button                            | Passed, 1,543 ms; query cleared and all three results returned. Hardware pointer stayed at `(437, 229)`. |
| Escape                                         | Passed, 1,207 ms; submitted conversation remains visible.                                                |

Times include the capture in each call and exclude host/model delays. The
compact cursor is visible in `custom-1789843673055-14-3.png`; its badge remains
separate from the scaled pointer. Search selection is independently checked by
OCR against the expected thread body, not just the presence of a sidebar title:

```sh
swift .local/computer-use-audit/search-selection-check.swift \
  .local/computer-use-audit/custom-1789843673055-4-1.png
# PASS: search closed and selected thread is visible
```

The same check failed on the pre-fix screenshot before cleanup. The final submission
capture is `custom-1789843673055-13-1.png`. The capture-error recovery message now
tells the host to refresh inventory and explicitly reactivate the exact window
before considering permission changes or another input.

No further native rebuild is needed for these tested fixes. Recording remains
paused and user-controlled. This run proves local native input through the actual
MCP `js` tool, with Codex interpreting screenshots. It does not establish Jev
model accuracy, browser-adapter behavior, or parity across desktop applications.
