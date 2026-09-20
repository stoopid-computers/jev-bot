import { parentPort } from "node:worker_threads";
import { start } from "node:repl";
import { PassThrough, Writable } from "node:stream";
import { inspect } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";

if (!parentPort) throw new Error("REPL worker requires a parent.");
const port = parentPort;
const evaluation = new AsyncLocalStorage<number>();
let sequence = 0;
const pending = new Map<
  number,
  { resolve(value: unknown): void; reject(error: Error): void }
>();
function call<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
  const id = ++sequence;
  return new Promise<T>((resolve, reject) => {
    // Both ends are owned by this package; the parent dispatch defines each result.
    pending.set(id, { resolve: (value) => resolve(value as T), reject });
    port.postMessage({
      type: "call",
      id,
      method,
      args,
      evaluationId: evaluation.getStore(),
    });
  });
}
function target(id: string) {
  return Object.freeze({
    getAXState: (options?: unknown) => call("getAXState", [id, options]),
    getScreenshot: async (options?: unknown) =>
      new Uint8Array(await call<Uint8Array>("getScreenshot", [id, options])),
    getAXStateAndScreenshot: async (options?: unknown) => {
      const result = await call<{ state: string; screenshot: Uint8Array }>(
        "getAXStateAndScreenshot",
        [id, options],
      );
      return { ...result, screenshot: new Uint8Array(result.screenshot) };
    },
    click: (element: number | string | readonly [number, number]) =>
      call("click", [id, element]),
    move: (point: readonly [number, number]) => call("move", [id, point]),
    setValue: (element: number | string, text: string) =>
      call("setValue", [id, element, text]),
    typeText: (text: string, options?: unknown) =>
      call("typeText", [id, text, options]),
    scroll: (
      point: readonly [number, number],
      direction: string,
      amount?: number,
    ) => call("scroll", [id, point, direction, amount]),
    pressKey: (key: string) => call("pressKey", [id, key]),
    act: (goal: string, options?: unknown) => call("act", [id, goal, options]),
  });
}
const input = new PassThrough();
const output = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});
const repl = start({
  input,
  output,
  prompt: "",
  terminal: false,
  useGlobal: false,
  ignoreUndefined: true,
  writer(value: unknown) {
    // Node's REPL reports synchronous throws and rejected top-level awaits to
    // its writer rather than the eval callback. Keep bindings after such errors.
    const error = value as { name?: string; message?: string };
    port.postMessage({
      type: "done",
      evaluationId: evaluation.getStore(),
      error: `${error?.name ?? "Error"}: ${error?.message ?? "JavaScript evaluation failed."}`,
    });
    return "";
  },
});
Object.assign(repl.context, {
  cua: Object.freeze({
    configureCursor: (options: unknown) => call("configureCursor", [options]),
    getState: (options?: unknown) => call("getState", [options]),
    listApps: (options?: unknown) => call("listApps", [options]),
    getApp: async (name: string, options?: unknown) =>
      target(await call<string>("getApp", [name, options])),
    getWindow: async (pid: number, windowId: number, options?: unknown) =>
      target(await call<string>("getWindow", [pid, windowId, options])),
    getDesktop: async () => target(await call<string>("getDesktop")),
  }),
  nodeRepl: Object.freeze({
    write: (value: unknown) =>
      call("write", [
        typeof value === "string" ? value : inspect(value, { depth: 8 }),
      ]),
    emitImage: (bytes: Uint8Array) => call("emitImage", [bytes]),
  }),
  console: Object.freeze({
    log: (...args: unknown[]) => {
      void call("write", [
        args
          .map((value) => (typeof value === "string" ? value : inspect(value)))
          .join(" "),
      ]);
    },
  }),
});
// Keep the ordinary interface focused on computer use. This is trusted local
// JavaScript, not an OS security sandbox for hostile source code.
for (const name of [
  "process",
  "require",
  "module",
  "fetch",
  "setTimeout",
  "setInterval",
  "setImmediate",
]) {
  Object.defineProperty(repl.context, name, {
    value: undefined,
    configurable: false,
    writable: false,
  });
}
port.on("message", (message) => {
  if (message.type === "result") {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter?.reject(new Error(message.error));
    else waiter?.resolve(message.value);
  } else if (message.type === "eval") {
    evaluation.run(message.evaluationId, () => {
      repl.eval(
        `${message.code}\n`,
        repl.context,
        "cua-repl",
        (error: Error | null, value: unknown) => {
          port.postMessage({
            type: "done",
            evaluationId: message.evaluationId,
            error: error ? `${error.name}: ${error.message}` : undefined,
            value:
              value === undefined ? undefined : inspect(value, { depth: 5 }),
          });
        },
      );
    });
  }
});
repl.on("error", (error: Error) =>
  port.postMessage({
    type: "done",
    evaluationId: evaluation.getStore(),
    error: `${error.name}: ${error.message}`,
  }),
);
