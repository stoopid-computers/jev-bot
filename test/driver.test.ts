import assert from "node:assert/strict";
import test from "node:test";

import {
  createDriver,
  createDriverSchemaValidator,
  type DriverClient,
} from "../src/driver.js";
import type { JsonObject, VisualAction, VisualTarget } from "../src/types.js";

const target = { pid: 42, windowId: 12 };
const session = "test-session";
const str = { type: "string" };
const int = { type: "integer" };
const bool = { type: "boolean" };
const common = {
  session: str,
  delivery_mode: { type: "string", enum: ["background", "foreground"] },
};

function tool(name: string, properties: JsonObject, required: string[] = []) {
  return {
    name,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

function tools() {
  return [
    tool("list_apps", {}),
    tool("list_windows", { pid: int, on_screen_only: bool }),
    tool(
      "get_window_state",
      {
        pid: int,
        window_id: int,
        session: str,
        query: str,
        include_screenshot: bool,
        include_accessibility_tree: bool,
        max_elements: int,
      },
      ["pid", "window_id"],
    ),
    tool(
      "click",
      { ...common, target: { type: "object" }, element_token: str },
      ["target", "delivery_mode"],
    ),
    tool(
      "type_text",
      { ...common, pid: int, window_id: int, element_token: str, text: str },
      ["text"],
    ),
    tool(
      "set_value",
      {
        session: str,
        pid: int,
        window_id: int,
        element_token: str,
        value: str,
      },
      ["pid", "value"],
    ),
    tool("press_key", { ...common, pid: int, window_id: int, key: str }, [
      "key",
    ]),
  ];
}

function state(): JsonObject {
  return {
    pid: 42,
    window_id: 12,
    snapshot_id: "s00000001",
    app_name: "Calculator",
    window_title: "Calculator",
    elements_complete: true,
    degraded: false,
    elements: [
      {
        element_index: 0,
        element_token: "s00000001:0",
        role: "AXButton",
        label: "7",
        enabled: true,
        actions: ["AXPress"],
        in_web_content: false,
      },
    ],
  };
}

function fake(
  inventory = tools(),
  result: unknown = { structuredContent: state() },
) {
  const calls: { name: string; arguments: JsonObject }[] = [];
  let closed = 0;
  const client: DriverClient = {
    async listTools() {
      return { tools: inventory };
    },
    async callTool(call) {
      calls.push(call);
      return result;
    },
    async close() {
      closed += 1;
    },
  };
  return { client, calls, closed: () => closed };
}

void test("observation requests the exact window, bounded accessibility and no screenshot", async () => {
  const fixture = fake();
  const driver = await createDriver(fixture.client, session);
  const observed = await driver.observe(target, "7");
  assert.equal(observed.elements[0]?.token, "s00000001:0");
  assert.equal(observed.complete, false);
  assert.deepEqual(fixture.calls, [
    {
      name: "get_window_state",
      arguments: {
        pid: 42,
        window_id: 12,
        session,
        query: "7",
        include_screenshot: false,
        include_accessibility_tree: true,
        max_elements: 256,
      },
    },
  ]);
  await driver.close();
  await driver.close();
  assert.equal(fixture.closed(), 1);
  await assert.rejects(driver.observe(target), /closed/);
});

void test("discovery does not leak unsupported session fields and returns bounded metadata", async () => {
  const fixture = fake(tools(), {
    structuredContent: {
      windows: [
        {
          pid: 42,
          window_id: 12,
          app_name: "App",
          title: "Title",
          is_on_screen: true,
          unexpected: "not returned",
        },
      ],
    },
  });
  const driver = await createDriver(fixture.client, session);
  assert.deepEqual(await driver.listWindows(), {
    windows: [
      {
        pid: 42,
        window_id: 12,
        app_name: "App",
        title: "Title",
        is_on_screen: true,
      },
    ],
  });
  assert.deepEqual(fixture.calls[0]?.arguments, {});
});

void test("click uses canonical target while typing and keys use advertised native flat fields", async () => {
  const fixture = fake(tools(), {
    structuredContent: {
      effect: "confirmed",
      route: "accessibility",
      delivery: { mode: "background" },
      evidence: [{ kind: "value_readback" }],
    },
  });
  const driver = await createDriver(fixture.client, session);
  const click = await driver.execute({
    kind: "click",
    target,
    elementToken: "s00000001:0",
  });
  assert.equal(click.executed, true);
  await driver.execute({
    kind: "type_text",
    target,
    elementToken: "s00000001:1",
    text: "hello",
  });
  await driver.execute({ kind: "press_key", target, key: "return" });
  assert.deepEqual(
    fixture.calls.map((call) => call.arguments),
    [
      {
        target: { kind: "window", pid: 42, window_id: 12 },
        session,
        delivery_mode: "background",
        element_token: "s00000001:0",
      },
      {
        pid: 42,
        window_id: 12,
        session,
        delivery_mode: "background",
        element_token: "s00000001:1",
        text: "hello",
      },
      {
        pid: 42,
        window_id: 12,
        session,
        delivery_mode: "background",
        key: "return",
      },
    ],
  );
});

void test("refuses portable typing contract lacking snapshot token targeting before mutation", async () => {
  const inventory = tools().map((entry) =>
    entry.name === "type_text"
      ? tool("type_text", { ...common, target: { type: "object" }, text: str })
      : entry,
  );
  const fixture = fake(inventory);
  const driver = await createDriver(fixture.client, session);
  await assert.rejects(
    driver.execute({
      kind: "type_text",
      target,
      elementToken: "s00000001:1",
      text: "private",
    }),
    /required safe input contract/,
  );
  assert.equal(fixture.calls.length, 0);
});

void test("refuses missing background mode and undocumented required fields without calls", async () => {
  for (const replacement of [
    tool("click", {
      session: str,
      target: { type: "object" },
      element_token: str,
    }),
    tool(
      "click",
      { ...common, target: { type: "object" }, element_token: str },
      ["unknown_field"],
    ),
  ]) {
    const fixture = fake(
      tools().map((entry) => (entry.name === "click" ? replacement : entry)),
    );
    const driver = await createDriver(fixture.client, session);
    await assert.rejects(
      driver.execute({ kind: "click", target, elementToken: "s00000001:0" }),
    );
    assert.equal(fixture.calls.length, 0);
  }
});

void test("never retries actions or exposes raw error content", async () => {
  const fixture = fake();
  fixture.client.callTool = async (call) => {
    fixture.calls.push(call);
    throw new Error("sensitive token from transport");
  };
  const driver = await createDriver(fixture.client, session);
  await assert.rejects(
    driver.execute({ kind: "click", target, elementToken: "s00000001:0" }),
    { message: "Driver request failed; its outcome is unknown" },
  );
  assert.equal(fixture.calls.length, 1);
});

async function observePayload(
  payload: JsonObject,
  requested = target,
  query?: string,
) {
  const fixture = fake(tools(), { structuredContent: payload });
  const driver = await createDriver(fixture.client, session);
  try {
    return await driver.observe(requested, query);
  } finally {
    await driver.close();
  }
}

async function executePayload(result: unknown) {
  const fixture = fake(tools(), result);
  const driver = await createDriver(fixture.client, session);
  try {
    return await driver.execute({
      kind: "click",
      target,
      elementToken: "s00000001:0",
    });
  } finally {
    await driver.close();
  }
}

void test("wrong-window, unsafe IDs, duplicate tokens and malformed snapshots fail at the driver boundary", async () => {
  for (const payload of [
    { ...state(), window_id: 999 },
    { ...state(), snapshot_id: undefined },
    { ...state(), degraded: "false" },
    {
      ...state(),
      elements: [
        { element_index: 0, element_token: "duplicate", role: "AXButton" },
        { element_index: 1, element_token: "duplicate", role: "AXButton" },
      ],
    },
  ])
    await assert.rejects(observePayload(payload));
  await assert.rejects(
    observePayload(state(), {
      ...target,
      windowId: Number.MAX_SAFE_INTEGER + 1,
    }),
  );
});

void test("secure fields and raw tree content never reach driver observations", async () => {
  const observed = await observePayload({
    ...state(),
    tree_markdown: "password secret",
    elements: [
      {
        element_index: 0,
        role: "AXSecureTextField",
        label: "Account",
        value: "secret-password",
      },
      {
        element_index: 1,
        role: "AXTextField",
        label: "Password",
        value: "another-secret",
      },
      {
        element_index: 2,
        role: "AXButton",
        label: "Continue",
        actions: ["AXPress"],
      },
    ],
  });
  assert.deepEqual(
    observed.elements.map((element) => element.label),
    ["Continue"],
  );
  assert.equal(observed.complete, false);
  assert.doesNotMatch(JSON.stringify(observed), /secret|password/i);
});

void test("partial, filtered and degraded driver observations cannot claim complete evidence", async () => {
  for (const flags of [
    { truncated: true },
    { degraded: true },
    { elements_complete: undefined },
    { filtered_element_count: 1 },
    { filtered_element_count: 0 },
  ])
    assert.equal(
      (await observePayload({ ...state(), ...flags })).complete,
      false,
    );
  assert.equal((await observePayload(state(), target, "7")).complete, false);
  assert.equal((await observePayload(state())).complete, true);
  await assert.rejects(
    observePayload({ ...state(), filtered_element_count: -1 }),
  );
});

void test("driver execution requires background evidence and redacts stale refusals", async () => {
  for (const payload of [
    { effect: "unverifiable", delivery: { mode: "background" } },
    { effect: "confirmed", delivery: { mode: "background" } },
    {
      effect: "confirmed",
      delivery: { mode: "foreground" },
      evidence: [{ kind: "value_readback" }],
    },
    { executed: true },
  ])
    assert.equal(
      (await executePayload({ structuredContent: payload })).executed,
      false,
    );
  const stale = await executePayload({
    isError: true,
    structuredContent: {
      refusal: { code: "stale_element_token", message: "private content" },
    },
  });
  assert.equal(stale.executed, false);
  assert.equal(stale.stale, true);
  assert.doesNotMatch(JSON.stringify(stale), /private content/);
});

void test("tool discovery handles pagination and rejects repeated cursors", async () => {
  const fixture = fake();
  let page = 0;
  fixture.client.listTools = async (input) => {
    assert.equal(input?.cursor, page === 0 ? undefined : "next");
    page += 1;
    return page === 1
      ? { tools: tools().slice(0, 2), nextCursor: "next" }
      : { tools: tools().slice(2) };
  };
  await createDriver(fixture.client, session);
  assert.equal(page, 2);
  fixture.client.listTools = async () => ({ tools: [], nextCursor: "loop" });
  await assert.rejects(
    createDriver(fixture.client, session),
    /did not terminate/,
  );
});

void test("app discovery preserves running identity without returning implementation metadata", async () => {
  const fixture = fake(tools(), {
    structuredContent: {
      apps: [
        {
          pid: 42,
          name: "Calculator",
          bundle_id: "com.apple.calculator",
          running: true,
          active: false,
          launch_path: "/private/path",
        },
        {
          pid: 0,
          name: "Notes",
          bundle_id: "com.apple.Notes",
          running: false,
          active: false,
        },
      ],
    },
  });
  const driver = await createDriver(fixture.client, session);
  assert.deepEqual(await driver.listApps!(), {
    apps: [
      {
        pid: 42,
        name: "Calculator",
        bundle_id: "com.apple.calculator",
        running: true,
        active: false,
      },
      {
        pid: 0,
        name: "Notes",
        bundle_id: "com.apple.Notes",
        running: false,
        active: false,
      },
    ],
  });
  assert.deepEqual(fixture.calls[0], { name: "list_apps", arguments: {} });
});

void test("screenshot requests a precise capture-only window and returns only its image", async () => {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
  const fixture = fake(tools(), {
    structuredContent: { pid: 42, window_id: 12 },
    content: [
      { type: "text", text: "not returned" },
      { type: "image", data: png, mimeType: "image/png" },
    ],
  });
  const driver = await createDriver(fixture.client, session);
  assert.deepEqual(await driver.screenshot!(target), {
    data: png,
    mimeType: "image/png",
  });
  assert.deepEqual(fixture.calls[0], {
    name: "get_window_state",
    arguments: {
      pid: 42,
      window_id: 12,
      session,
      include_screenshot: true,
      include_accessibility_tree: false,
    },
  });
});

void test("screenshot refuses different windows and invalid or ambiguous image payloads", async () => {
  for (const result of [
    { structuredContent: { pid: 42, window_id: 99 }, content: [] },
    { structuredContent: { pid: 42, window_id: 12 }, content: [] },
    {
      structuredContent: { pid: 42, window_id: 12 },
      content: [{ type: "image", data: "nope", mimeType: "image/png" }],
    },
    {
      structuredContent: { pid: 42, window_id: 12 },
      content: [{ type: "image" }, { type: "image" }],
    },
  ]) {
    const fixture = fake(tools(), result);
    const driver = await createDriver(fixture.client, session);
    await assert.rejects(driver.screenshot!(target));
  }
});

void test("set_value replaces through its exact semantic contract without typing or synthetic shortcuts", async () => {
  const fixture = fake(tools(), {
    structuredContent: {
      effect: "confirmed",
      route: "accessibility",
      delivery: { mode: "background" },
      evidence: [{ kind: "value_readback" }],
    },
  });
  const driver = await createDriver(fixture.client, session);
  assert.equal(
    (
      await driver.execute({
        kind: "set_value",
        target,
        elementToken: "s00000001:1",
        value: "replacement",
      })
    ).executed,
    true,
  );
  assert.deepEqual(fixture.calls, [
    {
      name: "set_value",
      arguments: {
        pid: 42,
        window_id: 12,
        session,
        element_token: "s00000001:1",
        value: "replacement",
      },
    },
  ]);
});

void test("set_value refuses absent snapshot-token support and never falls back to insertion", async () => {
  const inventory = tools().map((entry) =>
    entry.name === "set_value"
      ? tool(
          "set_value",
          { session: str, pid: int, window_id: int, value: str },
          ["pid", "value"],
        )
      : entry,
  );
  const fixture = fake(inventory);
  const driver = await createDriver(fixture.client, session);
  await assert.rejects(
    driver.execute({
      kind: "set_value",
      target,
      elementToken: "s00000001:1",
      value: "replacement",
    }),
    /required safe input contract/,
  );
  assert.equal(fixture.calls.length, 0);
});

void test("set_value uses explicit background mode if the installed Driver advertises one", async () => {
  const inventory = tools().map((entry) =>
    entry.name === "set_value"
      ? tool(
          "set_value",
          {
            ...common,
            target: { type: "object" },
            element_token: str,
            value: str,
          },
          ["target", "value"],
        )
      : entry,
  );
  const fixture = fake(inventory);
  const driver = await createDriver(fixture.client, session);
  await driver.execute({
    kind: "set_value",
    target,
    elementToken: "s00000001:1",
    value: "replacement",
  });
  assert.deepEqual(fixture.calls[0]?.arguments, {
    target: { kind: "window", pid: 42, window_id: 12 },
    session,
    delivery_mode: "background",
    element_token: "s00000001:1",
    value: "replacement",
  });
});

void test("macOS pending permissions reports the exact setup blocker without echoing native details", async () => {
  const fixture = fake(tools(), {
    isError: true,
    structuredContent: { code: "tool_invocation_failed", exit_code: 75 },
    content: [
      {
        type: "text",
        text: "permissions_pending: macOS Accessibility or Screen Recording permission is still pending; private native detail",
      },
    ],
  });
  const driver = await createDriver(fixture.client, session);
  await assert.rejects(driver.listApps!(), {
    message:
      "Cua Driver is waiting for macOS Accessibility or Screen Recording permission. Complete the system permission prompts, then retry.",
  });
  assert.equal(fixture.calls.length, 1);
});

void test("CUA integer formats validate without ignored-format warnings and retain standard formats", () => {
  const validator = createDriverSchemaValidator();
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const validate = validator.getValidator({
      type: "object",
      properties: {
        pid: { type: "integer", format: "uint32" },
        window: { type: "integer", format: "uint64" },
        uri: { type: "string", format: "uri" },
      },
      required: ["pid", "window", "uri"],
    });
    assert.equal(
      validate({ pid: 42, window: 12, uri: "https://example.com" }).valid,
      true,
    );
    assert.equal(
      validate({ pid: 4_294_967_296, window: 12, uri: "https://example.com" })
        .valid,
      false,
    );
    assert.equal(
      validate({
        pid: 42,
        window: Number.MAX_SAFE_INTEGER + 1,
        uri: "https://example.com",
      }).valid,
      false,
    );
    assert.equal(
      validate({ pid: 42, window: 12, uri: "not a uri" }).valid,
      false,
    );
    assert.equal(warnings.length, 0);
  } finally {
    console.warn = original;
  }
});

const pixel = { type: "number" };
const pngPixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";

function visualTools() {
  return [
    ...tools().map((entry) => {
      if (entry.name === "click")
        return tool("click", {
          ...common,
          target: { type: "object" },
          x: pixel,
          y: pixel,
        });
      if (entry.name === "type_text")
        return tool("type_text", {
          ...common,
          pid: int,
          window_id: int,
          x: pixel,
          y: pixel,
          text: str,
        });
      return entry;
    }),
    tool("scroll", {
      ...common,
      target: { type: "object" },
      x: pixel,
      y: pixel,
      direction: str,
      amount: int,
      by: str,
    }),
    tool("bring_to_front", { pid: int, window_id: int }, ["pid"]),
    tool("move_cursor", {
      session: str,
      target: { type: "object" },
      x: pixel,
      y: pixel,
    }),
    tool("get_desktop_state", { session: str }),
  ];
}

void test("window activation accepts only verified focus and exact window order", async () => {
  const activated = {
    pid: 42,
    window_id: 12,
    status: "activated",
    activated: true,
    exact_window_effect: {
      verified: true,
      focused: true,
      frontmost_ordinary: true,
    },
  };
  const fixture = fake(visualTools(), { structuredContent: activated });
  const driver = await createDriver(fixture.client, session);
  assert.deepEqual(await driver.activate!(target), { activated: true, target });
  assert.deepEqual(fixture.calls, [
    { name: "bring_to_front", arguments: { pid: 42, window_id: 12 } },
  ]);
  for (const flags of [
    { status: "partial" },
    { window_id: 99 },
    { activated: false },
    {
      exact_window_effect: {
        verified: true,
        focused: false,
        frontmost_ordinary: true,
      },
    },
    {
      exact_window_effect: {
        verified: false,
        focused: true,
        frontmost_ordinary: true,
      },
    },
  ]) {
    const failed = fake(visualTools(), {
      structuredContent: { ...activated, ...flags },
    });
    const failingDriver = await createDriver(failed.client, session);
    await assert.rejects(
      failingDriver.activate!(target),
      /exact window is foreground/,
    );
    assert.equal(failed.calls.length, 1);
  }
});

void test("visual inputs preserve the exact window and explicit background delivery", async () => {
  const fixture = fake(visualTools(), {
    structuredContent: { effect: "confirmed", verified: true },
  });
  const driver = await createDriver(fixture.client, session);
  for (const action of [
    { kind: "click", target, x: 10, y: 20 },
    { kind: "type_text", target, x: 30, y: 40, text: "hello" },
    { kind: "scroll", target, x: 50, y: 60, direction: "down", amount: 2 },
  ] satisfies VisualAction[]) {
    assert.deepEqual(await driver.visualExecute!(action), {
      attempted: true,
      executed: false,
      execution: "unknown",
      effect: "unverifiable",
    });
  }
  assert.deepEqual(fixture.calls, [
    {
      name: "click",
      arguments: {
        target: { kind: "window", pid: 42, window_id: 12 },
        session,
        delivery_mode: "background",
        x: 10,
        y: 20,
      },
    },
    {
      name: "type_text",
      arguments: {
        pid: 42,
        window_id: 12,
        session,
        delivery_mode: "background",
        x: 30,
        y: 40,
        text: "hello",
      },
    },
    {
      name: "scroll",
      arguments: {
        target: { kind: "window", pid: 42, window_id: 12 },
        session,
        delivery_mode: "background",
        x: 50,
        y: 60,
        direction: "down",
        amount: 2,
        by: "line",
      },
    },
  ]);
});

void test("desktop clicks use only the explicit primary-display target", async () => {
  const fixture = fake(visualTools(), {
    structuredContent: { effect: "unverifiable" },
  });
  const driver = await createDriver(fixture.client, session);
  await driver.visualExecute!({
    kind: "click",
    target: { displayId: "primary" },
    x: 0,
    y: 10,
  });
  assert.deepEqual(fixture.calls[0], {
    name: "click",
    arguments: {
      target: { kind: "desktop", display_id: "primary" },
      session,
      x: 0,
      y: 10,
    },
  });
  for (const action of [
    {
      kind: "type_text",
      target: { displayId: "primary" },
      x: 0,
      y: 10,
      text: "no",
    },
    {
      kind: "scroll",
      target: { displayId: "primary" },
      x: 0,
      y: 10,
      direction: "down",
    },
  ] satisfies VisualAction[]) {
    await assert.rejects(
      driver.visualExecute!(action),
      /clicks and moves only/,
    );
  }
  assert.equal(fixture.calls.length, 1);
});

void test("visual shortcuts send separate keys and modifiers only to the exact background window", async () => {
  const inventory = visualTools().map((entry) =>
    entry.name === "press_key"
      ? tool("press_key", {
          ...common,
          pid: int,
          window_id: int,
          key: str,
          modifiers: { type: "array", items: str },
        })
      : entry,
  );
  const fixture = fake(inventory, {
    structuredContent: { effect: "unverifiable" },
  });
  const driver = await createDriver(fixture.client, session);
  await driver.visualExecute!({
    kind: "press_key",
    target,
    key: "Meta+Shift+K",
  });
  assert.deepEqual(fixture.calls, [
    {
      name: "press_key",
      arguments: {
        pid: 42,
        window_id: 12,
        session,
        delivery_mode: "background",
        key: "k",
        modifiers: ["cmd", "shift"],
      },
    },
  ]);
  await assert.rejects(
    driver.visualExecute!({ kind: "press_key", target, key: "cmd+k+q" }),
    /key/i,
  );
  assert.equal(fixture.calls.length, 1);
});

void test("visual refusals expose a safe reason and do not describe input as attempted", async () => {
  const fixture = fake(visualTools(), {
    isError: true,
    structuredContent: {
      code: "off_space_or_ax_unresolved",
      effect: "refused",
      reason: "private native content",
    },
  });
  const driver = await createDriver(fixture.client, session);
  const receipt = await driver.visualExecute!({
    kind: "move",
    target,
    x: 10,
    y: 20,
  });
  assert.equal(receipt.attempted, false);
  assert.equal(receipt.effect, "refused");
  assert.equal(receipt.code, "off_space_or_ax_unresolved");
  assert.match(String(receipt.recovery), /current desktop/i);
  assert.doesNotMatch(JSON.stringify(receipt), /private native content/);
  assert.equal(fixture.calls.length, 1);
});

void test("visual input rejects invalid coordinates, text, wheel bounds and ambiguous targets before dispatch", async () => {
  const fixture = fake(visualTools());
  const driver = await createDriver(fixture.client, session);
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      driver.visualExecute!({ kind: "click", target, x: value, y: 1 }),
    );
    await assert.rejects(
      driver.visualExecute!({ kind: "click", target, x: 1, y: value }),
    );
  }
  for (const amount of [0, 51, 1.5, Number.NaN]) {
    await assert.rejects(
      driver.visualExecute!({
        kind: "scroll",
        target,
        x: 0,
        y: 0,
        direction: "down",
        amount,
      }),
    );
  }
  await assert.rejects(
    driver.visualExecute!({
      kind: "type_text",
      target,
      x: 0,
      y: 0,
      text: "a".repeat(8_001),
    }),
  );
  await assert.rejects(
    driver.visualExecute!({
      kind: "click",
      target: { ...target, displayId: "primary" },
      x: 0,
      y: 0,
    }),
  );
  assert.equal(fixture.calls.length, 0);
});

void test("pointer moves preserve original pixels and keep window and desktop targets separate", async () => {
  const fixture = fake(visualTools(), {
    structuredContent: { scope: "desktop", effect: "unverifiable" },
  });
  const driver = await createDriver(fixture.client, session);
  assert.deepEqual(
    await driver.visualExecute!({
      kind: "move",
      target: { displayId: "primary" },
      x: 600,
      y: 400,
    }),
    {
      attempted: true,
      executed: false,
      execution: "unknown",
      effect: "unverifiable",
    },
  );
  assert.deepEqual(fixture.calls, [
    {
      name: "move_cursor",
      arguments: {
        target: { kind: "desktop", display_id: "primary" },
        session,
        x: 600,
        y: 400,
      },
    },
  ]);
  await driver.visualExecute!({ kind: "move", target, x: 600, y: 400 });
  assert.deepEqual(fixture.calls[1], {
    name: "move_cursor",
    arguments: {
      target: { kind: "window", pid: 42, window_id: 12 },
      session,
      x: 600,
      y: 400,
    },
  });
});

void test("visual input refuses unsupported background or coordinate schemas without fallback", async () => {
  for (const replacement of [
    tool("click", {
      session: str,
      target: { type: "object" },
      x: pixel,
      y: pixel,
    }),
    tool("click", { ...common, target: { type: "object" } }),
    tool("click", {
      ...common,
      target: { type: "object" },
      x: pixel,
      y: pixel,
      delivery_mode: { type: "string", enum: ["foreground"] },
    }),
  ]) {
    const fixture = fake(
      visualTools().map((entry) =>
        entry.name === "click" ? replacement : entry,
      ),
    );
    const driver = await createDriver(fixture.client, session);
    await assert.rejects(
      driver.visualExecute!({ kind: "click", target, x: 10, y: 20 }),
    );
    assert.equal(fixture.calls.length, 0);
  }
});

void test("window pointer movement refuses a schema without exact canonical targets", async () => {
  const fixture = fake(
    visualTools().map((entry) =>
      entry.name === "move_cursor"
        ? tool("move_cursor", {
            session: str,
            x: pixel,
            y: pixel,
            pid: int,
            window_id: int,
          })
        : entry,
    ),
  );
  const driver = await createDriver(fixture.client, session);
  await assert.rejects(
    driver.visualExecute!({ kind: "move", target, x: 10, y: 20 }),
    /safe input contract/,
  );
  assert.equal(fixture.calls.length, 0);
});

void test("cursor configuration stays on its owned session and sends no desktop input", async () => {
  const fixture = fake([
    ...visualTools(),
    tool("set_agent_cursor_theme", {
      session: str,
      theme_id: str,
      reduced_motion: str,
    }),
    tool("set_agent_cursor_motion", {
      session: str,
      arc_size: pixel,
      spring: pixel,
      glide_duration_ms: pixel,
      dwell_after_click_ms: pixel,
      idle_hide_ms: pixel,
    }),
  ]);
  fixture.client.callTool = async (call) => {
    fixture.calls.push(call);
    return {
      structuredContent:
        call.name === "set_agent_cursor_theme"
          ? {
              session: call.arguments.session,
              theme: { id: call.arguments.theme_id },
            }
          : { session: call.arguments.session, motion: call.arguments },
    };
  };
  const driver = await createDriver(fixture.client, "Jev");
  assert.deepEqual(
    await driver.configureCursor!({
      themeId: "compootor.small",
      glideDurationMs: 120,
      dwellAfterClickMs: 0,
      idleHideMs: 20_000,
    }),
    {
      configured: true,
      session: "Jev",
      themeId: "compootor.small",
    },
  );
  assert.deepEqual(fixture.calls, [
    {
      name: "set_agent_cursor_theme",
      arguments: {
        session: "Jev",
        theme_id: "compootor.small",
        reduced_motion: "on",
      },
    },
    {
      name: "set_agent_cursor_motion",
      arguments: {
        session: "Jev",
        arc_size: 0,
        spring: 1,
        glide_duration_ms: 120,
        dwell_after_click_ms: 0,
        idle_hide_ms: 20_000,
      },
    },
  ]);
  const before = fixture.calls.length;
  for (const invalid of [
    { glideDurationMs: -1 },
    { glideDurationMs: 5_001 },
    { dwellAfterClickMs: Number.NaN },
    { idleHideMs: 60_001 },
    { themeId: "" },
    { session: "other" },
  ]) {
    await assert.rejects(driver.configureCursor!(invalid));
  }
  assert.equal(fixture.calls.length, before);
});

void test("cursor configuration validates all schemas before changing a theme", async () => {
  const fixture = fake([
    tool("set_agent_cursor_theme", {
      session: str,
      theme_id: str,
      reduced_motion: str,
    }),
    tool("set_agent_cursor_motion", { session: str }),
  ]);
  const driver = await createDriver(fixture.client, session);
  await assert.rejects(
    driver.configureCursor!({
      themeId: "compootor.small",
      glideDurationMs: 120,
    }),
  );
  assert.equal(fixture.calls.length, 0);
});

void test("visual action failures remain unknown and are never replayed", async () => {
  const fixture = fake(visualTools(), {
    isError: true,
    structuredContent: { message: "private details" },
  });
  const driver = await createDriver(fixture.client, session);
  assert.deepEqual(
    await driver.visualExecute!({ kind: "click", target, x: 10, y: 20 }),
    {
      attempted: true,
      executed: false,
      execution: "unknown",
      effect: "unknown",
    },
  );
  fixture.client.callTool = async (call) => {
    fixture.calls.push(call);
    throw new Error("sensitive transport context");
  };
  await assert.rejects(
    driver.visualExecute!({ kind: "click", target, x: 10, y: 20 }),
    {
      message: "Driver request failed; its outcome is unknown",
    },
  );
  assert.equal(fixture.calls.length, 2);
});

void test("visual screenshots separate exact windows from native primary-display coordinates", async () => {
  const desktop = {
    platform: "macos",
    display: "primary",
    screenshot_width: 1,
    screenshot_height: 1,
    screen_width: 1,
    screen_height: 1,
    scale_factor: 1,
  };
  for (const selected of [
    target,
    { displayId: "primary" },
  ] satisfies VisualTarget[]) {
    const fixture = fake(visualTools(), {
      structuredContent:
        "displayId" in selected ? desktop : { pid: 42, window_id: 12 },
      content: [{ type: "image", data: pngPixel, mimeType: "image/png" }],
    });
    const driver = await createDriver(fixture.client, session);
    assert.deepEqual(await driver.visualScreenshot!(selected), {
      data: pngPixel,
      mimeType: "image/png",
    });
    assert.deepEqual(
      fixture.calls[0],
      "displayId" in selected
        ? {
            name: "get_desktop_state",
            arguments: { session },
          }
        : {
            name: "get_window_state",
            arguments: {
              pid: 42,
              window_id: 12,
              session,
              include_screenshot: true,
              include_accessibility_tree: false,
            },
          },
    );
  }
  for (const changes of [
    { display: "secondary" },
    { pid: 42 },
    { scale_factor: 0 },
    { screenshot_width: 2 },
  ]) {
    const fixture = fake(visualTools(), {
      structuredContent: { ...desktop, ...changes },
      content: [{ type: "image", data: pngPixel, mimeType: "image/png" }],
    });
    const driver = await createDriver(fixture.client, session);
    await assert.rejects(driver.visualScreenshot!({ displayId: "primary" }));
  }
});

void test("degraded accessibility without a snapshot asks for a fresh exact-window observation", async () => {
  await assert.rejects(
    observePayload({ ...state(), snapshot_id: undefined, degraded: true }),
    /window.*observe again/i,
  );
});
