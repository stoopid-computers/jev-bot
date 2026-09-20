/**
 * Persistent computer-use sessions for native macOS apps, running in Node.js or Bun.
 * Importing this module starts no server, native driver, or model request.
 * @module
 */
export { createSession } from "./runtime.js";
export type { ComputerSession, SessionOptions } from "./runtime.js";
export { createServer } from "./server.js";
export type { ReplRuntimePort } from "./server.js";
export type {
  Candidate,
  Choose,
  Decision,
  Driver,
  Element,
  Expectation,
  JsonObject,
  NativeAction,
  Observation,
  RunRequest,
  RunResult,
  Target,
  VisualAction,
  VisualTarget,
} from "./types.js";
