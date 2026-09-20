import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer, type ReplRuntimePort } from "../dist/index.js";
import {
  deferred,
  desktopFixture,
  decision,
  png,
  text,
} from "./helpers/desktop.js";

async function connect(t: TestContext, runtime: ReplRuntimePort) {
  const server = createServer(runtime);
  const client = new Client({ name: "jev-bot-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await Promise.all([client.close(), server.close()]);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function execute(client: Client, code: string, timeout_ms = 1_000) {
  return CallToolResultSchema.parse(
    await client.callTool({
      name: "js",
      arguments: { code, title: "Test the session", timeout_ms },
    }),
  );
}

void test("publishes js and reset with strict schemas and conservative action annotations", async (t) => {
  const { session } = desktopFixture(t);
  const client = await connect(t, session);
  const { tools } = await client.listTools();
  assert.deepEqual(
    new Set(tools.map((tool) => tool.name)),
    new Set(["js", "reset"]),
  );
  for (const tool of tools)
    assert.equal(tool.inputSchema.additionalProperties, false);
  const js = tools.find((tool) => tool.name === "js");
  assert.deepEqual(js?.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.deepEqual(js?.inputSchema.required, ["code"]);
  assert.ok(client.getInstructions()?.trim());
});

void test("MCP edits persist across calls and return the observed text and screenshot", async (t) => {
  const { session } = desktopFixture(t);
  const client = await connect(t, session);
  const selected = await execute(
    client,
    "let app = await cua.getWindow(123,456);",
  );
  assert.notEqual(selected.isError, true, text(selected));
  const edited = await execute(client, 'await app.setValue(1,"MCP text");');
  assert.notEqual(edited.isError, true, text(edited));
  const observed = await execute(
    client,
    "await app.getAXStateAndScreenshot();",
  );
  assert.notEqual(observed.isError, true, text(observed));
  assert.match(text(observed), /AXTextField "Name" value="MCP text"/);
  assert.deepEqual(
    observed.content.filter((block) => block.type === "image"),
    [{ type: "image", data: png, mimeType: "image/png" }],
  );
});

void test("invalid tool arguments cannot execute code or reset existing bindings", async (t) => {
  const { session } = desktopFixture(t);
  const client = await connect(t, session);
  await execute(client, "let edits = 0;");
  const invalid = [
    {},
    { code: "" },
    { code: "   " },
    { code: "edits++", unexpected: true },
    { code: "edits++", timeout_ms: 0 },
    { code: "edits++", timeout_ms: 60_001 },
    { code: "edits++", timeout_ms: 1.5 },
    { code: "edits++", title: "" },
  ];
  for (const args of invalid) {
    const response = await client.callTool({ name: "js", arguments: args });
    assert.equal(response.isError, true, JSON.stringify(args));
  }
  const reset = await client.callTool({
    name: "reset",
    arguments: { force: true },
  });
  assert.equal(reset.isError, true);
  const unchanged = await execute(client, "await nodeRepl.write(edits);");
  assert.deepEqual(unchanged.content, [{ type: "text", text: "0" }]);
});

void test("MCP reset discards bindings without undoing native edits", async (t) => {
  const { session } = desktopFixture(t);
  const client = await connect(t, session);
  await execute(
    client,
    'let app = await cua.getWindow(123,456); await app.setValue(1,"Keep this");',
  );
  const reset = await client.callTool({ name: "reset", arguments: {} });
  assert.notEqual(reset.isError, true);
  assert.deepEqual(reset.structuredContent, { reset: true });
  const cleared = await execute(client, "await nodeRepl.write(typeof app);");
  assert.ok(
    cleared.content.some(
      (block) => block.type === "text" && block.text === "undefined",
    ),
  );
  const observed = await execute(
    client,
    "let app = await cua.getWindow(123,456);",
  );
  assert.match(text(observed), /AXTextField "Name" value="Keep this"/);
});

void test("a model's done choice reaches the MCP caller as handoff, not verified success", async (t) => {
  const { session, actions } = desktopFixture(
    t,
    {},
    async (_goal, _state, candidates) => decision(candidates, "done"),
  );
  const client = await connect(t, session);
  await execute(client, "let app = await cua.getWindow(123,456);");
  const response = await execute(client, 'await app.act("Save the document");');
  assert.notEqual(response.isError, true, text(response));
  assert.match(text(response), /"status":"handoff"/);
  assert.doesNotMatch(text(response), /"status":"verified"/);
  assert.deepEqual(actions, []);
  const failed = await execute(client, 'throw new Error("test failure");');
  assert.equal(failed.isError, true);
});

void test("exceptions from an embedded runtime do not expose its private details", async (t) => {
  const fail = async (): Promise<never> => {
    throw new Error("secret-api-key and private response body");
  };
  const client = await connect(t, { execute: fail, reset: fail });
  for (const name of ["js", "reset"]) {
    const response = await client.callTool({
      name,
      arguments: name === "js" ? { code: "await cua.getState()" } : {},
    });
    assert.equal(response.isError, true);
    assert.doesNotMatch(
      JSON.stringify(response),
      /secret-api-key|private response body/,
    );
  }
});

void test(
  "MCP cancellation stops the chooser, blocks later input, and resets bindings",
  { timeout: 5_000 },
  async (t) => {
    const started = deferred<void>();
    const aborted = deferred<void>();
    const { session, actions } = desktopFixture(
      t,
      {},
      async (_goal, _state, candidates, _history, signal) => {
        assert.ok(signal);
        signal.addEventListener("abort", () => aborted.resolve(), {
          once: true,
        });
        started.resolve();
        await aborted.promise;
        return decision(candidates, "handoff");
      },
    );
    const client = await connect(t, session);
    await execute(client, "let app = await cua.getWindow(123,456);");
    const controller = new AbortController();
    const pending = client.callTool(
      {
        name: "js",
        arguments: {
          code: 'await app.act("Save"); await app.pressKey("return");',
        },
      },
      undefined,
      { signal: controller.signal },
    );
    const rejected = assert.rejects(pending, /cancelled by test/);
    await started.promise;
    controller.abort(new Error("cancelled by test"));
    await rejected;
    await aborted.promise;
    let next;
    do {
      next = await execute(client, "await nodeRepl.write(typeof app);");
      if (next.isError) {
        assert.match(text(next), /busy/i);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } while (next.isError);
    assert.ok(
      next.content.some(
        (block) => block.type === "text" && block.text === "undefined",
      ),
    );
    assert.deepEqual(actions, []);
  },
);

void test(
  "MCP enforces the supplied execution deadline and remains usable",
  { timeout: 5_000 },
  async (t) => {
    const { session, actions } = desktopFixture(t);
    const client = await connect(t, session);
    await execute(client, "let app = await cua.getWindow(123,456);");
    const timedOut = await execute(
      client,
      'while (true) {} await app.pressKey("return");',
      75,
    );
    assert.equal(timedOut.isError, true);
    const next = await execute(client, "await nodeRepl.write(typeof app);");
    assert.ok(
      next.content.some(
        (block) => block.type === "text" && block.text === "undefined",
      ),
    );
    assert.deepEqual(actions, []);
  },
);
