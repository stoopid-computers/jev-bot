import assert from "node:assert/strict";
import test from "node:test";
import type { NativeAction, Target, VisualAction } from "../src/types.js";
import {
  desktopFixture,
  decision,
  png,
  target,
  text,
} from "./helpers/desktop.js";

function fixture(...args: Parameters<typeof desktopFixture>) {
  const result = desktopFixture(...args);
  return { ...result, repl: result.session };
}

void test("cursor tuning is available through the real REPL without desktop input", async (t) => {
  const configurations: unknown[] = [];
  const { repl, actions } = fixture(t, {
    configureCursor: async (options) => {
      configurations.push(options);
      return { applied: true };
    },
  });
  const result = await repl.execute(
    'await cua.configureCursor({themeId:"compootor.small",glideDurationMs:120,dwellAfterClickMs:0,idleHideMs:1500});',
  );
  assert.notEqual(result.isError, true, text(result));
  assert.deepEqual(configurations, [
    {
      themeId: "compootor.small",
      glideDurationMs: 120,
      dwellAfterClickMs: 0,
      idleHideMs: 1500,
    },
  ]);
  assert.deepEqual(actions, []);
  const invalid = await repl.execute(
    "await cua.configureCursor({glideDurationMs:-1});",
  );
  assert.equal(invalid.isError, true);
  assert.equal(configurations.length, 1);
});

void test("visual window input uses an explicit target and requires a fresh screenshot after each action", async (t) => {
  const visualActions: VisualAction[] = [];
  const activated: Target[] = [];
  const { repl, observations, actions } = fixture(t, {
    activate: async (selected) => {
      activated.push(selected);
      return { activated: true };
    },
    visualScreenshot: async () => ({ data: png, mimeType: "image/png" }),
    visualExecute: async (action) => {
      visualActions.push(action);
      return { executed: false, effect: "unverifiable" };
    },
  });
  const first = await repl.execute(
    'let visual = await cua.getWindow(123,456,{mode:"visual",activate:true});',
  );
  assert.notEqual(first.isError, true, text(first));
  assert.deepEqual(activated, [target]);
  assert.equal(observations.length, 0);
  assert.ok(first.content.some((block) => block.type === "image"));
  const outside = await repl.execute("await visual.click([1,0]);");
  assert.match(text(outside), /outside the original screenshot/);
  assert.equal(visualActions.length, 0);
  await repl.execute("await visual.click([0,0]);");
  assert.deepEqual(visualActions, [{ kind: "click", target, x: 0, y: 0 }]);
  const stale = await repl.execute("await visual.click([0,0]);");
  assert.match(text(stale), /fresh getScreenshot/);
  assert.equal(visualActions.length, 1);
  await repl.execute(
    'await visual.getScreenshot(); await visual.typeText("Hello",{at:[0,0]});',
  );
  assert.deepEqual(visualActions[1], {
    kind: "type_text",
    target,
    x: 0,
    y: 0,
    text: "Hello",
  });
  await repl.execute(
    'await visual.getScreenshot(); await visual.scroll([0,0],"down",2);',
  );
  assert.deepEqual(visualActions[2], {
    kind: "scroll",
    target,
    x: 0,
    y: 0,
    direction: "down",
    amount: 2,
  });
  assert.equal(actions.length, 0);
});

void test("a newer visual capture invalidates older handles for the same window", async (t) => {
  const visualActions: VisualAction[] = [];
  const { repl } = fixture(t, {
    visualScreenshot: async () => ({ data: png, mimeType: "image/png" }),
    visualExecute: async (action) => {
      visualActions.push(action);
      return { executed: false, effect: "unverifiable" };
    },
  });
  await repl.execute(
    'let first = await cua.getWindow(123,456,{mode:"visual"});',
  );
  await repl.execute(
    'let second = await cua.getWindow(123,456,{mode:"visual"});',
  );
  const stale = await repl.execute("await first.click([0,0]);");
  assert.equal(stale.isError, true);
  assert.match(text(stale), /fresh getScreenshot/);
  assert.equal(visualActions.length, 0);
  const fresh = await repl.execute("await second.click([0,0]);");
  assert.notEqual(fresh.isError, true, text(fresh));
  assert.deepEqual(visualActions, [{ kind: "click", target, x: 0, y: 0 }]);
});

void test("visual keyboard shortcuts target the selected window and invalidate its frame", async (t) => {
  const visualActions: VisualAction[] = [];
  const { repl } = fixture(t, {
    visualScreenshot: async () => ({ data: png, mimeType: "image/png" }),
    visualExecute: async (action) => {
      visualActions.push(action);
      return { executed: false, effect: "unverifiable" };
    },
  });
  await repl.execute(
    'let visual = await cua.getWindow(123,456,{mode:"visual"});',
  );
  const search = await repl.execute('await visual.pressKey("Cmd+K");');
  assert.notEqual(search.isError, true, text(search));
  assert.deepEqual(visualActions, [
    { kind: "press_key", target, key: "cmd+k" },
  ]);
  const stale = await repl.execute("await visual.click([0,0]);");
  assert.match(text(stale), /fresh getScreenshot/);
  await repl.execute("await visual.getScreenshot();");
  const invalid = await repl.execute('await visual.pressKey("cmd+k+q");');
  assert.equal(invalid.isError, true);
  assert.equal(visualActions.length, 1);
  const escape = await repl.execute('await visual.pressKey("Escape");');
  assert.notEqual(escape.isError, true, text(escape));
  assert.equal(visualActions.length, 2);
  await repl.execute("let desktop = await cua.getDesktop();");
  const global = await repl.execute('await desktop.pressKey("cmd+k");');
  assert.equal(global.isError, true);
  assert.equal(visualActions.length, 2);
});

void test("caret navigation preserves a selected native field, while focus-changing keys clear it", async (t) => {
  const { repl, actions } = fixture(t);
  await repl.execute(
    'let app = await cua.getApp("Test Editor"); await app.setValue(1,"abc");',
  );
  const insert = await repl.execute(
    'await app.pressKey("left"); await app.typeText("X");',
  );
  assert.notEqual(insert.isError, true, text(insert));
  const edited = await repl.execute(
    "await app.getAXState({disableDiffing:true});",
  );
  assert.match(text(edited), /AXTextField "Name".*value="abXc"/);
  const sent = actions.length;
  await repl.execute('await app.pressKey("tab");');
  const unselected = await repl.execute('await app.typeText("must not type");');
  assert.equal(unselected.isError, true);
  assert.equal(
    actions.length,
    sent + 1,
    "Tab must be the only new native input",
  );
  const unchanged = await repl.execute(
    "await app.getAXState({disableDiffing:true});",
  );
  assert.match(text(unchanged), /AXTextField "Name".*value="abXc"/);
});

void test("post-hover capture gives the app a bounded paint interval and supports an immediate read", async (t) => {
  let movedAt: number | undefined;
  const elapsed: number[] = [];
  const { repl } = fixture(t, {
    visualScreenshot: async () => {
      if (movedAt !== undefined) elapsed.push(performance.now() - movedAt);
      return { data: png, mimeType: "image/png" };
    },
    visualExecute: async () => {
      movedAt = performance.now();
      return { attempted: true, effect: "unverifiable" };
    },
  });
  await repl.execute(
    'let visual = await cua.getWindow(123,456,{mode:"visual"});',
  );
  const settled = await repl.execute(
    "await visual.move([0,0]); await visual.getScreenshot();",
  );
  assert.notEqual(settled.isError, true, text(settled));
  assert.ok(elapsed[0]! >= 90, `paint interval was ${elapsed[0]}ms`);
  const immediate = await repl.execute(
    "await visual.move([0,0]); await visual.getScreenshot({settleMs:0});",
  );
  assert.notEqual(immediate.isError, true, text(immediate));
  const invalid = await repl.execute(
    "await visual.getScreenshot({settleMs:1001});",
  );
  assert.equal(invalid.isError, true);
  assert.equal(elapsed.length, 2);
});

void test("a screenshot output failure leaves visual input blocked until a successful capture", async (t) => {
  const visualActions: VisualAction[] = [];
  const { repl } = fixture(t, {
    visualScreenshot: async () => ({ data: png, mimeType: "image/png" }),
    visualExecute: async (action) => {
      visualActions.push(action);
      return { executed: false, effect: "unverifiable" };
    },
  });
  await repl.execute(
    'let visual = await cua.getWindow(123,456,{mode:"visual"});',
  );
  const failed = await repl.execute(
    'for (let i=0; i<32; i++) await nodeRepl.write("fixture"); await visual.getScreenshot();',
  );
  assert.equal(failed.isError, true);
  assert.equal(
    failed.content.filter((block) => block.type === "image").length,
    0,
  );
  const stale = await repl.execute("await visual.click([0,0]);");
  assert.equal(stale.isError, true);
  assert.match(text(stale), /fresh getScreenshot/);
  assert.equal(visualActions.length, 0);
  const recovered = await repl.execute(
    "await visual.getScreenshot(); await visual.click([0,0]);",
  );
  assert.notEqual(recovered.isError, true, text(recovered));
  assert.equal(visualActions.length, 1);
});

void test("desktop selection is explicit and does not admit ungrounded typing or native indices", async (t) => {
  const visualActions: VisualAction[] = [];
  const { repl } = fixture(t, {
    visualScreenshot: async () => ({ data: png, mimeType: "image/png" }),
    visualExecute: async (action) => {
      visualActions.push(action);
      return { executed: false, effect: "unverifiable" };
    },
  });
  await repl.execute("let desktop = await cua.getDesktop();");
  const typed = await repl.execute(
    'await desktop.typeText("not allowed",{at:[0,0]});',
  );
  assert.match(text(typed), /clicks and pointer moves only/);
  const nativeIndex = await repl.execute("await desktop.click(1);");
  assert.equal(nativeIndex.isError, true);
  assert.equal(visualActions.length, 0);
  await repl.execute("await desktop.click([0,0]);");
  assert.deepEqual(visualActions, [
    { kind: "click", target: { displayId: "primary" }, x: 0, y: 0 },
  ]);
  await repl.reset();
  const old = await repl.execute("await desktop.getScreenshot();");
  assert.match(text(old), /desktop is not defined/);
});

void test("visual activation does not select the first of multiple app windows", async (t) => {
  let activations = 0;
  const { repl } = fixture(t, {
    listWindows: async () => ({
      windows: [
        { pid: 123, window_id: 456, title: "First", is_on_screen: false },
        { pid: 123, window_id: 789, title: "Second", is_on_screen: false },
      ],
    }),
    activate: async () => {
      activations++;
      return { activated: true };
    },
    visualScreenshot: async () => ({ data: png, mimeType: "image/png" }),
  });
  const result = await repl.execute(
    'await cua.getApp("Test Editor",{mode:"visual",activate:true});',
  );
  assert.match(text(result), /Select an exact window/);
  assert.equal(activations, 0);
});

void test("pointer moves preserve their explicit window or desktop target and require fresh pixels", async (t) => {
  const visualActions: VisualAction[] = [];
  const { repl } = fixture(t, {
    visualScreenshot: async () => ({ data: png, mimeType: "image/png" }),
    visualExecute: async (action) => {
      visualActions.push(action);
      return { executed: false, effect: "unverifiable" };
    },
  });
  await repl.execute(
    'let window = await cua.getWindow(123,456,{mode:"visual"});',
  );
  const windowMove = await repl.execute("await window.move([0,0]);");
  assert.notEqual(windowMove.isError, true, text(windowMove));
  await repl.execute("let desktop = await cua.getDesktop();");
  const moved = await repl.execute("await desktop.move([0,0]);");
  assert.notEqual(moved.isError, true, text(moved));
  assert.deepEqual(visualActions, [
    { kind: "move", target: { pid: 123, windowId: 456 }, x: 0, y: 0 },
    { kind: "move", target: { displayId: "primary" }, x: 0, y: 0 },
  ]);
  const stale = await repl.execute("await desktop.move([0,0]);");
  assert.equal(stale.isError, true);
  assert.match(text(stale), /fresh getScreenshot/);
  assert.equal(visualActions.length, 2);
});

void test(
  "persistent bindings support top-level await without repeating startup output",
  { timeout: 5_000 },
  async (t) => {
    const { repl } = fixture(t);
    const first = await repl.execute(
      "let count = await Promise.resolve(3); await nodeRepl.write(count);",
      undefined,
      1_000,
    );
    assert.notEqual(first.isError, true, text(first));
    assert.ok(
      first.content.some(
        (block) => block.type === "text" && block.text === "3",
      ),
    );
    const second = await repl.execute(
      "count += 4; await nodeRepl.write(count);",
      undefined,
      1_000,
    );
    assert.notEqual(second.isError, true, text(second));
    assert.equal(text(second), "7");
  },
);

void test(
  "getApp emits initial state and later observations report diffs or full state",
  { timeout: 5_000 },
  async (t) => {
    const { repl, observations, setElements } = fixture(t);
    const first = await repl.execute(
      'let app = await cua.getApp("Test Editor");',
      undefined,
      1_000,
    );
    assert.notEqual(first.isError, true, text(first));
    assert.match(
      text(first),
      /Test Editor: Document\n\[1\] AXTextField "Name"/,
    );
    assert.deepEqual(observations, [{ target, query: undefined }]);
    const unchanged = await repl.execute(
      "await app.getAXState();",
      undefined,
      1_000,
    );
    assert.match(text(unchanged), /No accessibility changes/);
    setElements([
      {
        index: 1,
        role: "AXTextField",
        label: "Name",
        value: "Sam",
        enabled: true,
        actions: ["AXPress"],
      },
    ]);
    const changed = await repl.execute(
      'await app.getAXState({query:"Name"});',
      undefined,
      1_000,
    );
    assert.match(text(changed), /- \[2\]/);
    assert.match(text(changed), /\+ \[1\].*value="Sam"/);
    assert.equal(observations.at(-1)?.query, "Name");
    const full = await repl.execute(
      "await app.getAXState({disableDiffing:true});",
      undefined,
      1_000,
    );
    assert.match(text(full), /\n\[1\]/);
    assert.doesNotMatch(text(full), /\n\+ /);
  },
);

void test(
  "direct mutations invalidate element indices until a fresh observation",
  { timeout: 5_000 },
  async (t) => {
    const { repl, actions } = fixture(t);
    await repl.execute(
      'let app = await cua.getApp("Test Editor");',
      undefined,
      1_000,
    );
    const pressed = await repl.execute("await app.click(2);", undefined, 1_000);
    assert.notEqual(pressed.isError, true, text(pressed));
    assert.equal(actions.length, 1);
    const stale = await repl.execute("await app.click(2);", undefined, 500);
    assert.equal(stale.isError, true);
    assert.match(text(stale), /Read fresh getAXState/);
    assert.doesNotMatch(text(stale), /timed out/);
    assert.equal(actions.length, 1);
    const refreshed = await repl.execute(
      "await app.getAXState(); await app.click(2);",
      undefined,
      1_000,
    );
    assert.notEqual(refreshed.isError, true, text(refreshed));
    assert.equal(actions.length, 2);
    assert.notDeepEqual(actions[0], actions[1]);
  },
);

void test(
  "screenshots emit image content and invalidate indices; combined state refreshes them",
  { timeout: 5_000 },
  async (t) => {
    const { repl, actions } = fixture(t);
    await repl.execute(
      'let app = await cua.getApp("Test Editor");',
      undefined,
      1_000,
    );
    const screenshot = await repl.execute(
      "let shot = await app.getScreenshot();",
      undefined,
      1_000,
    );
    assert.notEqual(screenshot.isError, true, text(screenshot));
    assert.deepEqual(screenshot.content, [
      { type: "image", data: png, mimeType: "image/png" },
    ]);
    const stale = await repl.execute("await app.click(2);", undefined, 500);
    assert.equal(stale.isError, true);
    assert.match(text(stale), /Read fresh getAXState/);
    assert.equal(actions.length, 0);
    const both = await repl.execute(
      "await app.getAXStateAndScreenshot(); await app.click(2);",
      undefined,
      1_000,
    );
    assert.notEqual(both.isError, true, text(both));
    assert.equal(
      both.content.some((block) => block.type === "image"),
      true,
    );
    assert.match(text(both), /\[2\] AXButton "Save"/);
    assert.equal(actions.length, 1);
  },
);

void test("Jev insertion and semantic replacement preserve the caller's exact text", async (t) => {
  const offered: NativeAction[][] = [];
  const { repl } = fixture(t, {}, async (_goal, _state, candidates) => {
    offered.push(
      candidates.flatMap((candidate) =>
        candidate.action ? [candidate.action] : [],
      ),
    );
    const selected = candidates.find(
      (candidate) =>
        candidate.action?.kind === "type_text" ||
        candidate.action?.kind === "set_value",
    );
    assert.ok(selected);
    return decision(candidates, selected.id);
  });
  const setup = await repl.execute(
    'let app = await cua.getApp("Test Editor"); await app.setValue(1,"Prefix");',
  );
  assert.notEqual(setup.isError, true, text(setup));
  const inserted = await repl.execute(
    'await app.act("Insert the supplied text into Name", {text:"  Sam\\n", maxSteps:1, expect:{labelEquals:"Name", valueEquals:"Prefix  Sam\\n"}});',
  );
  assert.notEqual(inserted.isError, true, text(inserted));
  assert.match(text(inserted), /"status":"verified"/);
  const replacement = await repl.execute(
    'await app.setValue("Name field", "  Sam\\n"); await app.getAXState({disableDiffing:true});',
  );
  assert.notEqual(replacement.isError, true, text(replacement));
  assert.match(text(replacement), /AXTextField "Name" value="  Sam\\n"/);
  assert.doesNotMatch(text(replacement), /value="Prefix/);
  assert.ok(offered[0]?.some((action) => action.kind === "type_text"));
  assert.equal(
    offered[0]?.some((action) => action.kind === "set_value"),
    false,
  );
  assert.deepEqual(
    offered[1]?.map((action) => action.kind),
    ["set_value"],
  );
});

void test(
  "reset discards selected apps and JavaScript bindings",
  { timeout: 5_000 },
  async (t) => {
    const { repl } = fixture(t);
    await repl.execute(
      'let app = await cua.getApp("Test Editor"); let previous = 9;',
      undefined,
      1_000,
    );
    await repl.reset();
    const next = await repl.execute(
      "await nodeRepl.write([typeof app, typeof previous]);",
      undefined,
      1_000,
    );
    assert.notEqual(next.isError, true, text(next));
    assert.match(text(next), /\[ 'undefined', 'undefined' \]/);
  },
);

void test(
  "an infinite loop times out, cannot execute a later action, and loses its bindings",
  { timeout: 5_000 },
  async (t) => {
    const { repl, actions } = fixture(t);
    await repl.execute(
      'let app = await cua.getApp("Test Editor");',
      undefined,
      1_000,
    );
    const result = await repl.execute(
      'while (true) {} await app.pressKey("return");',
      undefined,
      100,
    );
    assert.equal(result.isError, true);
    assert.match(text(result), /timed out.*bindings were reset/s);
    const next = await repl.execute(
      "await nodeRepl.write(typeof app);",
      undefined,
      1_000,
    );
    assert.notEqual(next.isError, true, text(next));
    assert.ok(
      next.content.some(
        (block) => block.type === "text" && block.text === "undefined",
      ),
    );
    assert.equal(actions.length, 0);
  },
);

void test(
  "a rejected API promise returns an error promptly and leaves the REPL usable",
  { timeout: 5_000 },
  async (t) => {
    const { repl } = fixture(t, {
      listApps: async () => {
        throw new Error("Native listing failed.");
      },
    });
    await repl.execute("let preserved = 27;", undefined, 1_000);
    const failed = await repl.execute("await cua.listApps();", undefined, 500);
    assert.equal(failed.isError, true);
    assert.match(text(failed), /Native listing failed/);
    assert.doesNotMatch(text(failed), /timed out/);
    const next = await repl.execute(
      "await nodeRepl.write(preserved);",
      undefined,
      1_000,
    );
    assert.notEqual(next.isError, true, text(next));
    assert.equal(text(next), "27");
  },
);

void test(
  "cancellation reaches an in-flight Jev run and clears the worker bindings",
  { timeout: 5_000 },
  async (t) => {
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let providerSignal: AbortSignal | undefined;
    const { repl, actions } = fixture(
      t,
      {},
      async (_goal, _state, candidates, _history, signal) => {
        providerSignal = signal;
        assert.ok(signal);
        const cancelled = new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        markStarted();
        await cancelled;
        return decision(candidates, "handoff");
      },
    );
    await repl.execute(
      'let app = await cua.getApp("Test Editor");',
      undefined,
      1_000,
    );
    const controller = new AbortController();
    const pending = repl.execute(
      'await app.act("Open preferences"); await app.pressKey("return");',
      controller.signal,
      2_000,
    );
    await started;
    controller.abort();
    const result = await pending;
    assert.equal(result.isError, true);
    assert.match(text(result), /cancelled.*bindings were reset/s);
    assert.equal(providerSignal?.aborted, true);
    const next = await repl.execute(
      "await nodeRepl.write(typeof app);",
      undefined,
      1_000,
    );
    assert.ok(
      next.content.some(
        (block) => block.type === "text" && block.text === "undefined",
      ),
    );
    assert.equal(actions.length, 0);
  },
);

void test(
  "a delayed unawaited continuation cannot act during a later evaluation",
  { timeout: 5_000 },
  async (t) => {
    const { repl, actions } = fixture(t);
    await repl.execute(
      'let app = await cua.getApp("Test Editor");',
      undefined,
      1_000,
    );
    const setup = await repl.execute(
      `
    let releaseOld;
    let oldRejected = false;
    let gate = new Promise(resolve => { releaseOld = resolve; });
    void gate.then(() => app.pressKey("return")).catch(() => { oldRejected = true; });
  `,
      undefined,
      1_000,
    );
    assert.notEqual(setup.isError, true, text(setup));
    const next = await repl.execute(
      'releaseOld(); await nodeRepl.write("current evaluation");',
      undefined,
      1_000,
    );
    assert.notEqual(next.isError, true, text(next));
    assert.equal(text(next), "current evaluation");
    const checked = await repl.execute(
      "await nodeRepl.write(oldRejected);",
      undefined,
      1_000,
    );
    assert.equal(text(checked), "true");
    assert.equal(actions.length, 0);
  },
);

for (const interruption of ["cancel", "timeout"] as const) {
  void test(
    `typeText cannot act after ${interruption} during its fresh observation`,
    { timeout: 5_000 },
    async (t) => {
      let reads = 0;
      let markReadStarted: () => void = () => {};
      let releaseRead: () => void = () => {};
      const readStarted = new Promise<void>((resolve) => {
        markReadStarted = resolve;
      });
      const delayedRead = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const { repl, actions } = fixture(t, {
        observe: async (selected) => {
          reads++;
          if (reads === 2) {
            markReadStarted();
            await delayedRead;
          }
          return {
            target: selected,
            snapshotId: `delayed-${reads}`,
            appName: "Test Editor",
            windowTitle: "Document",
            elements: [
              {
                index: 1,
                token: `field-${reads}`,
                role: "AXTextField",
                label: "Name",
                enabled: true,
                actions: ["AXPress"],
              },
            ],
            complete: true,
            degraded: false,
          };
        },
      });
      const setup = await repl.execute(
        'let app = await cua.getApp("Test Editor"); await app.setValue(1, "first");',
        undefined,
        1_000,
      );
      assert.notEqual(setup.isError, true, text(setup));
      assert.deepEqual(
        actions.map((action) => action.kind),
        ["set_value"],
      );
      const controller = new AbortController();
      const pending = repl.execute(
        'await app.typeText("must not be typed");',
        controller.signal,
        interruption === "timeout" ? 75 : 1_000,
      );
      await readStarted;
      if (interruption === "cancel") controller.abort();
      const stopped = await pending;
      assert.equal(stopped.isError, true);
      assert.match(
        text(stopped),
        interruption === "cancel" ? /cancelled/ : /timed out/,
      );
      releaseRead();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(
        actions.map((action) => action.kind),
        ["set_value"],
      );
      const next = await repl.execute(
        'await nodeRepl.write("ready");',
        undefined,
        1_000,
      );
      assert.notEqual(next.isError, true, text(next));
      assert.deepEqual(
        actions.map((action) => action.kind),
        ["set_value"],
      );
    },
  );
}

void test(
  "a semantic field selection clears the previous numeric text target",
  { timeout: 5_000 },
  async (t) => {
    const { repl, actions } = fixture(
      t,
      {},
      async (_goal, _state, candidates) => {
        const selected = candidates.find(
          (candidate) => candidate.action?.kind === "set_value",
        );
        assert.ok(selected);
        return decision(candidates, selected.id);
      },
    );
    const selected = await repl.execute(
      'let app = await cua.getApp("Test Editor"); await app.setValue(1, "field A");',
      undefined,
      1_000,
    );
    assert.notEqual(selected.isError, true, text(selected));
    assert.equal(actions.length, 1);
    const semantic = await repl.execute(
      'await app.setValue("Name field", "second field");',
      undefined,
      1_000,
    );
    assert.notEqual(semantic.isError, true, text(semantic));
    const observed = await repl.execute(
      "await app.getAXState({disableDiffing:true});",
    );
    assert.match(text(observed), /AXTextField "Name" value="second field"/);
    const sent = actions.length;
    const attempted = await repl.execute(
      'await app.typeText("must not reach field A");',
      undefined,
      1_000,
    );
    assert.equal(attempted.isError, true);
    assert.match(text(attempted), /Use setValue\(index, text\)/);
    assert.equal(actions.length, sent);
    const unchanged = await repl.execute(
      "await app.getAXState({disableDiffing:true});",
    );
    assert.match(text(unchanged), /AXTextField "Name" value="second field"/);
  },
);
