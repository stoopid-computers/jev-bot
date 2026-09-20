import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return CallToolResultSchema.parse(result)
    .content.filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

void test(
  "real stdio server advertises js/reset and runs persistent JavaScript without desktop or TypeSafe access",
  { timeout: 10_000 },
  async (t) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
        "stdio",
      ],
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        TYPESAFE_API_KEY: "",
        CUA_DRIVER_BIN: "/does-not-exist/cua-driver",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "jev-bot-stdio-test", version: "1.0.0" });
    t.after(async () => {
      await client.close();
      await transport.close();
    });
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      ["js", "reset"],
    );
    assert.ok(client.getInstructions()?.trim());
    const first = await client.callTool({
      name: "js",
      arguments: {
        code: "let value = await Promise.resolve(6); await nodeRepl.write(value);",
        title: "Check the JavaScript session",
        timeout_ms: 1_000,
      },
    });
    assert.notEqual(first.isError, true, text(first));
    assert.ok(
      CallToolResultSchema.parse(first).content.some(
        (block) => block.type === "text" && block.text === "6",
      ),
    );
    const next = await client.callTool({
      name: "js",
      arguments: {
        code: "value += 2; await nodeRepl.write(value);",
        timeout_ms: 1_000,
      },
    });
    assert.notEqual(next.isError, true, text(next));
    assert.equal(text(next), "8");
    const reset = await client.callTool({ name: "reset", arguments: {} });
    assert.notEqual(reset.isError, true, text(reset));
    const afterReset = await client.callTool({
      name: "js",
      arguments: {
        code: "await nodeRepl.write(typeof value);",
        timeout_ms: 1_000,
      },
    });
    assert.notEqual(afterReset.isError, true, text(afterReset));
    assert.ok(
      CallToolResultSchema.parse(afterReset).content.some(
        (block) => block.type === "text" && block.text === "undefined",
      ),
    );
  },
);

void test("CLI rejects malformed options before starting a desktop connection", async () => {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  for (const args of [
    ["--env-file"],
    ["--env-file", ""],
    ["doctor", "stdio"],
    ["--env-file", "a", "--env-file", "b"],
    ["--unknown"],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.doesNotMatch(result.stdout, /connected|jsonrpc/);
  }
});

void test(
  "CLI accepts an explicit environment file for stdio and reports missing files",
  { timeout: 10_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "jev-bot-cli-env-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const envFile = join(directory, "test.env");
    await writeFile(envFile, "JEV_BOT_TEST_CONFIG=loaded-from-explicit-file\n");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
        "--env-file",
        envFile,
        "stdio",
      ],
      env: {
        TYPESAFE_API_KEY: "",
        CUA_DRIVER_BIN: "/does-not-exist/cua-driver",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "jev-bot-env-test", version: "1.0.0" });
    t.after(async () => {
      await client.close();
      await transport.close();
    });
    const missing = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
        "--env-file",
        join(directory, "missing.env"),
        "stdio",
      ],
      { encoding: "utf8", timeout: 2_000 },
    );
    assert.equal(missing.error, undefined);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /missing\.env|environment file/i);
    await client.connect(transport);
    const result = await client.callTool({
      name: "js",
      arguments: {
        code: "await nodeRepl.write(37);",
      },
    });
    assert.notEqual(result.isError, true, text(result));
    assert.ok(
      CallToolResultSchema.parse(result).content.some(
        (block) => block.type === "text" && block.text === "37",
      ),
    );
  },
);
