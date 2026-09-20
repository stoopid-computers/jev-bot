import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.js";

/** Persistent JavaScript operations required by the MCP server. */
export interface ReplRuntimePort {
  /**
   * Run JavaScript and return MCP text or image content.
   * Sessions created by `createSession` keep bindings between calls and accept
   * only one active call. Inspect the returned `isError` flag before continuing.
   *
   * @param code Nonblank JavaScript, up to 50,000 characters in the default runtime.
   * @param signal Cancels execution. Native input already sent may have occurred.
   * @param timeoutMs Execution deadline in milliseconds. Defaults to 30,000.
   */
  execute(
    code: string,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<CallToolResult>;
  /**
   * Clear JavaScript bindings and selected apps without undoing native input.
   * Wait for active execution to finish or cancel it before resetting.
   */
  reset(): Promise<void>;
}

const instructions =
  "Use js with persistent JavaScript bindings. Start with await cua.getState() or " +
  "let app = await cua.getApp(...); the entry call returns state and API guidance. " +
  "Use documented APIs and observe after input. app.act(goal, options) runs bounded Jev selection. " +
  "The host owns planning, exact text, visual targeting, and authorization. Model DONE is not verified success. " +
  "Visual coordinates use original PNG pixels; get a fresh screenshot after input. reset clears bindings.";

function failure(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Create an MCP server with `js` and `reset` tools backed by a runtime.
 * Connect the returned server to your MCP transport. The caller owns the
 * runtime's lifetime and must close its session when finished.
 *
 * @param runtime Persistent JavaScript runtime, usually from `createSession`.
 * @returns An MCP server that has not yet connected to a transport.
 */
export function createServer(runtime: ReplRuntimePort): McpServer {
  const server = new McpServer(
    { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    { instructions },
  );

  server.registerTool(
    "js",
    {
      description:
        "Run JavaScript in a persistent computer-use session through the documented cua API. Start with cua.getState() or cua.getApp(). Use app methods for deterministic actions, then observe; app.act delegates a bounded task to Jev. The host supplies planning, exact text, visual fallback, and task authorization. Returns text and images emitted by the session.",
      inputSchema: z
        .object({
          code: z
            .string()
            .min(1)
            .refine(
              (value) => value.trim().length > 0,
              "Code must contain JavaScript.",
            )
            .describe(
              "JavaScript to run using persistent bindings and the documented cua API.",
            ),
          title: z
            .string()
            .min(1)
            .max(200)
            .optional()
            .describe("Short description of what this call does."),
          timeout_ms: z
            .number()
            .int()
            .min(1)
            .max(60_000)
            .default(30_000)
            .describe(
              "Execution timeout in milliseconds, from 1 to 60000. Defaults to 30000.",
            ),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      try {
        return await runtime.execute(args.code, extra.signal, args.timeout_ms);
      } catch {
        return failure(
          "Computer-use JavaScript failed. Inspect current state before retrying; actions may have occurred.",
        );
      }
    },
  );

  server.registerTool(
    "reset",
    {
      description:
        "Reset the persistent computer-use JavaScript session and discard its bindings. Begin the next js call with cua.getState() or cua.getApp() to obtain current state and API guidance.",
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        await runtime.reset();
        return {
          content: [
            {
              type: "text",
              text: "Computer-use JavaScript session reset. Persistent bindings were cleared.",
            },
          ],
          structuredContent: { reset: true },
        };
      } catch {
        return failure("Computer-use JavaScript session reset failed.");
      }
    },
  );

  return server;
}
