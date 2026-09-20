import assert from "node:assert/strict";
import test from "node:test";
import { deferred, desktopFixture, decision, text } from "./helpers/desktop.js";
import { createSession } from "../dist/index.js";
import type { Driver } from "../src/types.js";
import { LazyDriver } from "../src/runtime.js";
import {
  createDriver,
  DriverConnectionError,
  type DriverClient,
} from "../src/driver.js";

async function nativeConnection(
  call: (
    request: Parameters<DriverClient["callTool"]>[0],
    disconnect: () => void,
  ) => Promise<unknown>,
  close: () => Promise<void> = async () => {},
) {
  let connected = true;
  return createDriver(
    {
      isConnected: () => connected,
      listTools: async () => ({
        tools: [
          {
            name: "list_windows",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "press_key",
            inputSchema: {
              type: "object",
              properties: {
                session: { type: "string" },
                pid: { type: "integer" },
                window_id: { type: "integer" },
                key: { type: "string" },
                delivery_mode: { type: "string", enum: ["background"] },
              },
            },
          },
        ],
      }),
      callTool: (request) =>
        call(request, () => {
          connected = false;
        }),
      close,
    },
    "transport-test",
  );
}

void test("closed Cua transports reconnect for reads without replaying input", async () => {
  let connections = 0;
  let closes = 0;
  const inputs: unknown[] = [];
  const driver = new LazyDriver(async () => {
    const failed = ++connections === 1;
    return nativeConnection(
      async (request, disconnect) => {
        if (request.name === "press_key") inputs.push(request.arguments);
        if (failed || request.name === "press_key") {
          disconnect();
          throw new Error("transport closed");
        }
        return { structuredContent: { windows: [] } };
      },
      async () => {
        closes++;
      },
    );
  });
  try {
    assert.deepEqual(await driver.listWindows(), { windows: [] });
    assert.equal(connections, 2);
    assert.equal(closes, 1);
    await assert.rejects(
      driver.execute({
        kind: "press_key",
        target: { pid: 1, windowId: 2 },
        key: "return",
      }),
      DriverConnectionError,
    );
    assert.equal(inputs.length, 1);
    assert.equal(connections, 2);
  } finally {
    await driver.close();
  }
  await assert.rejects(driver.listWindows(), /closed/i);
  assert.equal(connections, 2);
});

void test("native permission refusals do not reconnect and repeated transport failure stops", async () => {
  for (const failure of ["permissions", "disconnect"] as const) {
    let connections = 0;
    const driver = new LazyDriver(async () => {
      connections++;
      return nativeConnection(async (_request, disconnect) => {
        if (failure === "disconnect") {
          disconnect();
          throw new Error("transport closed");
        }
        return {
          isError: true,
          structuredContent: { code: "tool_invocation_failed", exit_code: 75 },
          content: [
            {
              type: "text",
              text: "permissions_pending: Accessibility is unavailable",
            },
          ],
        };
      });
    });
    try {
      await assert.rejects(
        driver.listWindows(),
        failure === "disconnect" ? DriverConnectionError : /permission/i,
      );
      assert.equal(connections, failure === "disconnect" ? 2 : 1);
    } finally {
      await driver.close();
    }
  }
});

void test("public sessions preserve bindings and own one connection shutdown", async () => {
  let closes = 0;
  const driver: Driver = {
    async listApps() {
      return { apps: [] };
    },
    async listWindows() {
      return { windows: [] };
    },
    async observe() {
      throw new Error("No native observation expected");
    },
    async execute() {
      throw new Error("No native input expected");
    },
    async close() {
      closes++;
    },
  };
  const session = createSession({ driver });
  try {
    const first = await session.execute("let total = 3;", undefined, 1_000);
    assert.notEqual(first.isError, true, JSON.stringify(first));
    const next = await session.execute(
      "await nodeRepl.write(total + 4);",
      undefined,
      1_000,
    );
    assert.deepEqual(next.content, [{ type: "text", text: "7" }]);
    const inventory = await session.execute(
      "await cua.getState();",
      undefined,
      1_000,
    );
    assert.notEqual(inventory.isError, true, text(inventory));
    assert.match(text(inventory), /"apps":\[\]/);
    assert.match(text(inventory), /"windows":\[\]/);

    await session.reset();
    const cleared = await session.execute(
      "await nodeRepl.write(typeof total);",
      undefined,
      1_000,
    );
    assert(
      cleared.content.some(
        (item) => item.type === "text" && item.text === "undefined",
      ),
    );
  } finally {
    await Promise.all([session.close(), session.close()]);
  }
  assert.equal(closes, 1);
  await assert.rejects(session.execute("1 + 1"), /Session is closed/);
  await assert.rejects(session.reset(), /Session is closed/);
});

void test(
  "an active session rejects overlapping calls and reset, then accepts new work",
  { timeout: 5_000 },
  async (t) => {
    const started = deferred<void>();
    const released = deferred<void>();
    t.after(() => released.resolve());
    const { session, actions } = desktopFixture(
      t,
      {},
      async (_goal, _state, candidates) => {
        started.resolve();
        await released.promise;
        return decision(candidates, "handoff");
      },
    );
    await session.execute("let app = await cua.getWindow(123,456);");
    const pending = session.execute('await app.act("Save");');
    await started.promise;
    await assert.rejects(
      session.execute('await app.pressKey("return");'),
      /running/i,
    );
    await assert.rejects(session.reset(), /running/i);
    assert.deepEqual(actions, []);
    released.resolve();
    assert.notEqual((await pending).isError, true);
    const next = await session.execute(
      "await app.getAXState({disableDiffing:true});",
    );
    assert.notEqual(next.isError, true, text(next));
    assert.match(text(next), /AXTextField "Name"/);
  },
);

void test(
  "closing a session waits for native input and closes the connection once",
  { timeout: 5_000 },
  async (t) => {
    const started = deferred<void>();
    const released = deferred<void>();
    t.after(() => released.resolve());
    let closes = 0;
    const { session } = desktopFixture(t, {
      execute: async () => {
        started.resolve();
        await released.promise;
        return { executed: true };
      },
      close: async () => {
        closes++;
      },
    });
    await session.execute("let app = await cua.getWindow(123,456);");
    const input = session.execute("await app.click(2);");
    await started.promise;
    const closing = session.close();
    await assert.rejects(session.execute("await cua.getState();"), /closed/i);
    assert.equal(
      closes,
      0,
      "closing cannot tear down an in-flight native operation",
    );
    released.resolve();
    await Promise.all([closing, input]);
    await session.close();
    assert.equal(closes, 1);
  },
);

void test(
  "closing a session drains a failed read without inheriting its error",
  { timeout: 5_000 },
  async (t) => {
    const started = deferred<void>();
    const read = deferred<never>();
    t.after(() => read.reject(new Error("read interrupted")));
    let closes = 0;
    const { session } = desktopFixture(t, {
      observe: async () => {
        started.resolve();
        return read.promise;
      },
      close: async () => {
        closes++;
      },
    });
    const pending = session.execute("await cua.getWindow(123,456);");
    await started.promise;
    const closing = session.close();
    assert.equal(closes, 0);
    read.reject(new Error("read interrupted"));
    await closing;
    assert.equal((await pending).isError, true);
    assert.equal(closes, 1);
  },
);

void test("failed connection shutdown is reported consistently without retrying it", async () => {
  let closes = 0;
  const session = createSession({
    driver: {
      listWindows: async () => ({ windows: [] }),
      observe: async () => {
        throw new Error("unexpected desktop read");
      },
      execute: async () => {
        throw new Error("unexpected input");
      },
      close: async () => {
        closes++;
        throw new Error("close failed");
      },
    },
  });
  await assert.rejects(session.close(), /close failed/);
  await assert.rejects(session.close(), /close failed/);
  await assert.rejects(session.execute("await cua.getState();"), /closed/i);
  assert.equal(closes, 1);
});

void test("uncertain direct input is reported without replaying it", async (t) => {
  let attempts = 0;
  const { session } = desktopFixture(t, {
    execute: async () => {
      attempts++;
      throw new Error("response lost after input");
    },
  });
  await session.execute("let app = await cua.getWindow(123,456);");
  const result = await session.execute("await app.click(2);");
  assert.notEqual(result.isError, true, text(result));
  assert.match(text(result), /"outcome":"unknown"/);
  assert.match(text(result), /"executed":false/);
  assert.equal(attempts, 1);
  const stale = await session.execute("await app.click(2);");
  assert.equal(stale.isError, true);
  assert.equal(attempts, 1);
});

void test("empty replacement clears a field and subsequent insertion starts from empty", async (t) => {
  const { session, actions } = desktopFixture(t);
  await session.execute(
    'let app = await cua.getWindow(123,456); await app.setValue(1,"Old text");',
  );
  const cleared = await session.execute(
    'await app.getAXState(); await app.setValue(1,""); await app.getAXState({disableDiffing:true});',
  );
  assert.notEqual(cleared.isError, true, text(cleared));
  assert.match(text(cleared), /AXTextField "Name" value=""/);
  const inserted = await session.execute(
    'await app.typeText("New text"); await app.getAXState({disableDiffing:true});',
  );
  assert.match(text(inserted), /AXTextField "Name" value="New text"/);
  const sent = actions.length;
  const tooLong = await session.execute(
    'await app.setValue(1,"x".repeat(8001));',
  );
  assert.equal(tooLong.isError, true);
  assert.equal(actions.length, sent);
});

void test("a cancelled call never starts native input", async (t) => {
  const { session, actions, observations } = desktopFixture(t);
  const result = await session.execute(
    "let app = await cua.getWindow(123,456); await app.click(2);",
    AbortSignal.abort(),
  );
  assert.equal(result.isError, true);
  assert.deepEqual(actions, []);
  assert.deepEqual(observations, []);
  const next = await session.execute("await nodeRepl.write(typeof app);");
  assert.ok(
    next.content.some(
      (block) => block.type === "text" && block.text === "undefined",
    ),
  );
});

void test(
  "cancelling in-flight native input blocks the next action without replaying the first",
  { timeout: 5_000 },
  async (t) => {
    const started = deferred();
    const release = deferred();
    t.after(() => release.resolve());
    const attempts: unknown[] = [];
    const { session } = desktopFixture(t, {
      execute: async (action) => {
        attempts.push(action);
        started.resolve();
        await release.promise;
        return { executed: true };
      },
    });
    await session.execute("let app = await cua.getWindow(123,456);");
    const controller = new AbortController();
    const pending = session.execute(
      'await app.click(2); await app.pressKey("return");',
      controller.signal,
    );
    await started.promise;
    controller.abort();
    const interrupted = await pending;
    assert.equal(interrupted.isError, true);
    release.resolve();
    await session.close();
    assert.equal(attempts.length, 1);
  },
);

void test("unavailable optional driver capabilities return errors and leave the session usable", async (t) => {
  const { session, actions } = desktopFixture(t, {
    listApps: undefined,
    screenshot: undefined,
  });
  const apps = await session.execute("await cua.listApps();");
  assert.equal(apps.isError, true);
  const selected = await session.execute(
    "let app = await cua.getWindow(123,456);",
  );
  assert.notEqual(selected.isError, true, text(selected));
  const screenshot = await session.execute("await app.getScreenshot();");
  assert.equal(screenshot.isError, true);
  const observed = await session.execute(
    "await app.getAXState({disableDiffing:true});",
  );
  assert.notEqual(observed.isError, true, text(observed));
  assert.match(text(observed), /AXTextField "Name"/);
  assert.deepEqual(actions, []);
});
