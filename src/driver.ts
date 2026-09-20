import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { Ajv } from "ajv";
import addFormatsModule from "ajv-formats";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.js";
import { parseKeyChord } from "./keys.js";

import type {
  Driver,
  Element,
  JsonObject,
  Observation,
  Target,
  VisualTarget,
} from "./types.js";

/** The injectable MCP boundary keeps contract tests independent of a desktop. */
export interface DriverClient {
  /** Optional transport liveness signal. False must mean the connection closed. */
  isConnected?(): boolean;
  listTools(input?: { cursor?: string }): Promise<unknown>;
  callTool(input: { name: string; arguments: JsonObject }): Promise<unknown>;
  close(): Promise<void>;
}

/** A closed native transport. A failed input is still unsafe to replay. */
export class DriverConnectionError extends Error {
  constructor() {
    super(
      "Driver connection closed. Observe again to reconnect; input was not retried.",
    );
    this.name = "DriverConnectionError";
  }
}

const MAX_ELEMENTS = 256;
const SECURE = /password|secure.?text|secure.?field/i;

export function createDriverSchemaValidator(): AjvJsonSchemaValidator {
  const ajv = new Ajv({
    strict: false,
    validateFormats: true,
    validateSchema: false,
    allErrors: true,
  });
  addFormatsModule.default(ajv);
  ajv.addFormat("uint32", {
    type: "number",
    validate: (value: number) =>
      Number.isInteger(value) && value >= 0 && value <= 4_294_967_295,
  });
  ajv.addFormat("uint64", {
    type: "number",
    // JSON numbers outside JavaScript's safe range cannot identify a window
    // or element reliably, even when valid as Rust u64 values.
    validate: (value: number) => Number.isSafeInteger(value) && value >= 0,
  });
  return new AjvJsonSchemaValidator(ajv);
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Driver returned an invalid object");
  }
  return value as JsonObject;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Driver target must use positive safe integers");
  }
  return value;
}

function string(value: unknown, limit = 8_192): string {
  if (typeof value !== "string" || value.length > limit) {
    throw new Error("Driver returned an invalid string");
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : string(value);
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean")
    throw new Error("Driver returned an invalid boolean");
  return value;
}

function targetOf(value: Target): Target {
  const pid = positiveInteger(value.pid);
  if (pid > 4_294_967_295) throw new Error("Driver process ID is out of range");
  return { pid, windowId: positiveInteger(value.windowId) };
}

/** Normalize only the documented WindowStateOutput fields, never tree Markdown. */
export function normalizeObservation(
  value: unknown,
  requested: Target,
  queried = false,
): Observation {
  const target = targetOf(requested);
  const state = object(value);
  if (state.pid !== target.pid || state.window_id !== target.windowId) {
    throw new Error("Driver observation belongs to a different window");
  }
  if (state.degraded === true && !state.snapshot_id) {
    throw new Error(
      "Exact window accessibility is unavailable. Bring the window onto the current desktop and observe again.",
    );
  }
  const snapshotId = string(state.snapshot_id, 256);
  if (
    !snapshotId ||
    !Array.isArray(state.elements) ||
    state.elements.length > MAX_ELEMENTS
  ) {
    throw new Error("Driver observation lacks a bounded snapshot");
  }
  const tokens = new Set<string>();
  const indices = new Set<number>();
  let redacted = false;
  const elements: Element[] = [];
  for (const item of state.elements) {
    const raw = object(item);
    const role = string(raw.role, 256);
    const label = optionalString(raw.label);
    const index = raw.element_index;
    if (
      typeof index !== "number" ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      indices.has(index)
    ) {
      throw new Error("Driver observation has invalid element indices");
    }
    indices.add(index);
    const token = optionalString(raw.element_token);
    if (
      token !== undefined &&
      (!token || token.length > 256 || tokens.has(token))
    ) {
      throw new Error("Driver observation has invalid element tokens");
    }
    if (token !== undefined) tokens.add(token);
    const enabled = optionalBoolean(raw.enabled);
    const inWebContent = optionalBoolean(raw.in_web_content);
    if (SECURE.test(role) || (label !== undefined && SECURE.test(label))) {
      redacted = true;
      continue;
    }
    const value = optionalString(raw.value);
    const actions = raw.actions ?? [];
    if (!Array.isArray(actions) || actions.length > 64) {
      throw new Error("Driver observation has invalid element actions");
    }
    elements.push(
      Object.freeze({
        index,
        role,
        ...(token === undefined ? {} : { token }),
        ...(label === undefined ? {} : { label }),
        ...(value === undefined ? {} : { value }),
        ...(enabled === undefined ? {} : { enabled }),
        ...(inWebContent === undefined ? {} : { inWebContent }),
        actions: Object.freeze(actions.map((action) => string(action, 256))),
      }),
    );
  }
  const degraded = optionalBoolean(state.degraded) ?? false;
  const truncated = optionalBoolean(state.truncated) ?? false;
  const declaredComplete = optionalBoolean(state.elements_complete) === true;
  // This field is the projected response size, not the number omitted. Even
  // zero means a filter was applied and cannot prove whole-window absence.
  const filtered =
    state.filtered_element_count !== undefined &&
    state.filtered_element_count !== null;
  if (
    filtered &&
    (typeof state.filtered_element_count !== "number" ||
      !Number.isSafeInteger(state.filtered_element_count) ||
      state.filtered_element_count < 0)
  ) {
    throw new Error("Driver observation has an invalid filtered element count");
  }
  return Object.freeze({
    target: Object.freeze(target),
    snapshotId,
    appName: optionalString(state.app_name) ?? "",
    windowTitle: optionalString(state.window_title) ?? "",
    elements: Object.freeze(elements),
    complete:
      declaredComplete &&
      !truncated &&
      !redacted &&
      !degraded &&
      !filtered &&
      !queried,
    degraded,
  });
}

function normalizeWindows(value: JsonObject): JsonObject {
  if (!Array.isArray(value.windows) || value.windows.length > 1_024) {
    throw new Error("Driver returned invalid window discovery");
  }
  return {
    windows: value.windows.map((item) => {
      const row = object(item);
      const pid = row.pid === null ? null : positiveInteger(row.pid);
      return {
        pid,
        window_id: positiveInteger(row.window_id),
        app_name: string(row.app_name),
        title: string(row.title),
        is_on_screen: optionalBoolean(row.is_on_screen) ?? false,
      };
    }),
  };
}

function normalizeApps(value: JsonObject): JsonObject {
  if (!Array.isArray(value.apps) || value.apps.length > 2_048) {
    throw new Error("Driver returned invalid app discovery");
  }
  return {
    apps: value.apps.map((item) => {
      const row = object(item);
      const running = optionalBoolean(row.running);
      const active = optionalBoolean(row.active);
      if (
        running === undefined ||
        active === undefined ||
        (active && !running)
      ) {
        throw new Error("Driver returned invalid app status");
      }
      const pid = !running && row.pid === 0 ? 0 : positiveInteger(row.pid);
      const bundleId = optionalString(row.bundle_id);
      return {
        pid,
        name: string(row.name),
        running,
        active,
        ...(bundleId === undefined ? {} : { bundle_id: bundleId }),
      };
    }),
  };
}

function screenshotImage(
  result: unknown,
  target: VisualTarget,
): { data: string; mimeType: string } {
  const { envelope, data } = structured(result);
  if (envelope.isError || !data || data.refusal || data.status === "refused") {
    if (data?.code === "tool_invocation_failed" && !("displayId" in target)) {
      throw new Error(
        "Window capture is unavailable (tool_invocation_failed). Refresh the window inventory, reselect the exact window with activate:true, and inspect a new screenshot. Do not repeat prior input without checking its effect. If capture still fails, check Screen Recording permission.",
      );
    }
    throw new Error(
      failureMessage("Driver screenshot was refused or unavailable", data),
    );
  }
  if ("displayId" in target) {
    if (
      data.platform !== "macos" ||
      data.display !== "primary" ||
      data.pid !== undefined ||
      data.window_id !== undefined
    ) {
      throw new Error("Driver screenshot belongs to a different display");
    }
    positiveInteger(data.screenshot_width);
    positiveInteger(data.screenshot_height);
    positiveInteger(data.screen_width);
    positiveInteger(data.screen_height);
    if (
      typeof data.scale_factor !== "number" ||
      !Number.isFinite(data.scale_factor) ||
      data.scale_factor <= 0
    ) {
      throw new Error("Driver returned an invalid display scale");
    }
  } else if (data.pid !== target.pid || data.window_id !== target.windowId) {
    throw new Error("Driver screenshot belongs to a different window");
  }
  if (!Array.isArray(envelope.content))
    throw new Error("Driver returned no screenshot");
  const images = envelope.content.filter((item) => {
    return (
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      (item as JsonObject).type === "image"
    );
  });
  if (images.length !== 1)
    throw new Error("Driver returned an ambiguous screenshot");
  const image = object(images[0]);
  const mimeType = string(image.mimeType, 64);
  // The native window screenshot contract publishes PNG images.
  if (mimeType !== "image/png")
    throw new Error("Driver returned an unsupported screenshot format");
  const encoded = string(image.data, 32 * 1_024 * 1_024);
  if (
    !encoded ||
    encoded.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  ) {
    throw new Error("Driver returned invalid screenshot data");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    throw new Error("Driver returned invalid PNG data");
  }
  if (
    "displayId" in target &&
    (bytes.length < 24 ||
      bytes.toString("ascii", 12, 16) !== "IHDR" ||
      bytes.readUInt32BE(16) !== data.screenshot_width ||
      bytes.readUInt32BE(20) !== data.screenshot_height)
  ) {
    throw new Error("Driver screenshot dimensions do not match the display");
  }
  return { data: encoded, mimeType };
}

function visualTargetOf(value: VisualTarget): VisualTarget {
  if ("displayId" in value) {
    if (
      value.displayId !== "primary" ||
      "pid" in value ||
      "windowId" in value
    ) {
      throw new Error(
        "Visual input requires one exact window or primary display",
      );
    }
    return { displayId: "primary" };
  }
  return targetOf(value);
}

function coordinate(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Visual coordinates must be finite nonnegative numbers");
  }
  return value;
}

function properties(schema: JsonObject): JsonObject {
  return object(schema.properties);
}

function requireFields(schema: JsonObject, fields: string[]): void {
  const props = properties(schema);
  if (fields.some((field) => !Object.hasOwn(props, field))) {
    throw new Error(
      "Installed Driver does not advertise the required safe input contract",
    );
  }
}

function argumentsFor(schema: JsonObject, args: JsonObject): JsonObject {
  requireFields(schema, Object.keys(args));
  const required = schema.required ?? [];
  if (
    !Array.isArray(required) ||
    required.some((key) => typeof key !== "string" || !Object.hasOwn(args, key))
  ) {
    throw new Error("Installed Driver requires unsupported input fields");
  }
  return args;
}

function windowArguments(schema: JsonObject, target: Target): JsonObject {
  if (Object.hasOwn(properties(schema), "target")) {
    return {
      target: { kind: "window", pid: target.pid, window_id: target.windowId },
    };
  }
  requireFields(schema, ["pid", "window_id"]);
  return { pid: target.pid, window_id: target.windowId };
}

function background(schema: JsonObject): void {
  requireFields(schema, ["session", "delivery_mode"]);
  const delivery = object(properties(schema).delivery_mode);
  if (!Array.isArray(delivery.enum) || !delivery.enum.includes("background")) {
    throw new Error("Installed Driver does not advertise background delivery");
  }
}

function structured(result: unknown): {
  envelope: JsonObject;
  data?: JsonObject;
} {
  const envelope = object(result);
  const data =
    envelope.structuredContent === undefined
      ? undefined
      : object(envelope.structuredContent);
  return { envelope, data };
}

// Native error text can contain private app content or arguments. Publish only
// known codes and our own recovery text, never the provider's raw description.
const recoveryByCode: Readonly<Record<string, string>> = {
  off_space_or_ax_unresolved:
    "Bring the exact window onto the current desktop, then capture it again.",
  target_minimized: "Restore the target window, then capture it again.",
  app_hidden: "Show the target app, then capture its exact window again.",
  stale_element_token:
    "Read fresh accessibility state before selecting the control again.",
  px_window_not_found: "Refresh the window inventory and select a live window.",
  px_capture_unavailable:
    "Check capture permission and take a fresh window screenshot.",
  px_frame_mismatch:
    "Capture the exact window again before choosing new coordinates.",
  action_outcome_mismatch:
    "Input may have occurred. Inspect a fresh screenshot before continuing; do not replay it automatically.",
  tool_invocation_failed:
    "The native driver could not complete this call. Check the driver connection and permissions before continuing.",
};

function failureDetail(data?: JsonObject): {
  code?: string;
  recovery?: string;
} {
  const refusal = data?.refusal;
  const nested =
    refusal && typeof refusal === "object" && !Array.isArray(refusal)
      ? object(refusal)
      : undefined;
  const code = nested?.code ?? data?.code;
  if (typeof code !== "string" || !Object.hasOwn(recoveryByCode, code))
    return {};
  return { code, recovery: recoveryByCode[code] };
}

function failureMessage(fallback: string, data?: JsonObject): string {
  const detail = failureDetail(data);
  return detail.code
    ? `${fallback} (${String(detail.code)}). ${String(detail.recovery)}`
    : fallback;
}

function visualReceipt(result: unknown): JsonObject {
  const { envelope, data } = structured(result);
  const refused =
    data?.effect === "refused" ||
    Boolean(data?.refusal) ||
    data?.status === "refused";
  if (refused)
    return {
      attempted: false,
      executed: false,
      execution: "not_attempted",
      effect: "refused",
      ...failureDetail(data),
    };
  const failed = envelope.isError || !data;
  return {
    attempted: true,
    executed: false,
    execution: "unknown",
    effect: failed ? "unknown" : "unverifiable",
    ...(failed ? failureDetail(data) : {}),
  };
}

function permissionsPending(envelope: JsonObject, data?: JsonObject): boolean {
  return (
    envelope.isError === true &&
    data?.code === "tool_invocation_failed" &&
    data.exit_code === 75 &&
    Array.isArray(envelope.content) &&
    envelope.content.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item))
        return false;
      const content = item as JsonObject;
      return (
        content.type === "text" &&
        typeof content.text === "string" &&
        content.text.startsWith("permissions_pending:")
      );
    })
  );
}

/** Do not equate a successful MCP response with a delivered desktop action. */
export function normalizeReceipt(result: unknown): JsonObject {
  const { envelope, data } = structured(result);
  const refusal =
    data?.refusal && typeof data.refusal === "object"
      ? object(data.refusal)
      : undefined;
  if (refusal?.code === "stale_element_token") {
    return { executed: false, stale: true, effect: "refused" };
  }
  if (envelope.isError || !data || refusal || data.status === "refused") {
    return {
      executed: false,
      effect: data?.effect === "refused" ? "refused" : "unknown",
      ...failureDetail(data),
    };
  }
  const delivery =
    data.delivery && typeof data.delivery === "object"
      ? object(data.delivery)
      : undefined;
  const knownEffect = [
    "confirmed",
    "partial",
    "unverifiable",
    "suspected_noop",
    "refused",
  ].includes(String(data.effect));
  const effect = knownEffect ? data.effect : "unknown";
  const evidence =
    Array.isArray(data.evidence) &&
    data.evidence.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item))
        return false;
      return ["value_readback", "window_change"].includes(
        String((item as JsonObject).kind),
      );
    });
  return {
    executed:
      effect === "confirmed" && evidence && delivery?.mode === "background",
    effect,
    ...(delivery?.mode === "background" ? { delivery: "background" } : {}),
  };
}

export async function createDriver(
  client: DriverClient,
  session = `Jev ${randomUUID().slice(0, 8)}`,
): Promise<Driver> {
  const schemas = new Map<string, JsonObject>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 16; page += 1) {
    const inventory = object(
      await client.listTools(cursor === undefined ? undefined : { cursor }),
    );
    if (!Array.isArray(inventory.tools))
      throw new Error("Driver returned invalid tool discovery");
    for (const item of inventory.tools) {
      const tool = object(item);
      const name = string(tool.name, 256);
      if (schemas.has(name))
        throw new Error("Driver advertised duplicate tools");
      schemas.set(name, object(tool.inputSchema));
    }
    if (inventory.nextCursor === undefined) break;
    cursor = string(inventory.nextCursor, 1_024);
    if (cursors.has(cursor) || page === 15)
      throw new Error("Driver tool discovery did not terminate");
    cursors.add(cursor);
  }
  let closed = false;
  function schema(name: string): JsonObject {
    if (closed) throw new Error("Driver connection is closed");
    const result = schemas.get(name);
    if (!result) throw new Error("Installed Driver is missing a required tool");
    return result;
  }
  async function call(name: string, args: JsonObject): Promise<unknown> {
    argumentsFor(schema(name), args);
    if (client.isConnected?.() === false) throw new DriverConnectionError();
    try {
      return await client.callTool({ name, arguments: args });
    } catch {
      if (client.isConnected?.() === false) throw new DriverConnectionError();
      // Provider and transport errors can contain arguments or environment data.
      throw new Error("Driver request failed; its outcome is unknown");
    }
  }
  async function read(name: string, args: JsonObject): Promise<JsonObject> {
    const { envelope, data } = structured(await call(name, args));
    if (permissionsPending(envelope, data)) {
      throw new Error(
        "Cua Driver is waiting for macOS Accessibility or Screen Recording permission. Complete the system permission prompts, then retry.",
      );
    }
    if (
      envelope.isError ||
      !data ||
      data.refusal ||
      data.status === "refused"
    ) {
      throw new Error(
        failureMessage("Driver observation was refused or unavailable", data),
      );
    }
    return data;
  }
  return {
    async configureCursor(options) {
      const supplied = object(options);
      const allowed = new Set([
        "themeId",
        "glideDurationMs",
        "dwellAfterClickMs",
        "idleHideMs",
      ]);
      if (Object.keys(supplied).some((key) => !allowed.has(key))) {
        throw new Error("Unsupported cursor configuration option");
      }
      const themeId =
        options.themeId === undefined
          ? undefined
          : string(options.themeId, 200);
      if (themeId !== undefined && !themeId.trim()) {
        throw new Error("Cursor theme ID must not be blank");
      }
      const motion: JsonObject = { session, arc_size: 0, spring: 1 };
      for (const [key, value, maximum] of [
        ["glide_duration_ms", options.glideDurationMs, 5_000],
        ["dwell_after_click_ms", options.dwellAfterClickMs, 5_000],
        ["idle_hide_ms", options.idleHideMs, 60_000],
      ] as const) {
        if (value === undefined) continue;
        if (
          typeof value !== "number" ||
          !Number.isFinite(value) ||
          value < 0 ||
          value > maximum
        ) {
          throw new Error("Cursor timing is outside its supported range");
        }
        motion[key] = value;
      }
      argumentsFor(schema("set_agent_cursor_motion"), motion);
      const theme =
        themeId === undefined
          ? undefined
          : { session, theme_id: themeId, reduced_motion: "on" };
      if (theme) {
        argumentsFor(schema("set_agent_cursor_theme"), theme);
        const applied = await read("set_agent_cursor_theme", theme);
        if (
          applied.session !== session ||
          object(applied.theme).id !== themeId
        ) {
          throw new Error(
            "Driver did not acknowledge this session's cursor theme",
          );
        }
      }
      const applied = await read("set_agent_cursor_motion", motion);
      const appliedMotion = object(applied.motion);
      if (
        applied.session !== session ||
        Object.entries(motion).some(
          ([key, value]) => key !== "session" && appliedMotion[key] !== value,
        )
      ) {
        throw new Error(
          "Driver did not acknowledge this session's cursor motion",
        );
      }
      return {
        configured: true,
        session,
        ...(themeId === undefined ? {} : { themeId }),
      };
    },
    async listApps() {
      const supported = properties(schema("list_apps"));
      const args = Object.hasOwn(supported, "session") ? { session } : {};
      return normalizeApps(await read("list_apps", args));
    },
    async listWindows() {
      const supported = properties(schema("list_windows"));
      const args = Object.hasOwn(supported, "session") ? { session } : {};
      return normalizeWindows(await read("list_windows", args));
    },
    async observe(requested, query) {
      const target = targetOf(requested);
      const args: JsonObject = {
        pid: target.pid,
        window_id: target.windowId,
        session,
        include_screenshot: false,
        include_accessibility_tree: true,
        max_elements: MAX_ELEMENTS,
      };
      if (query !== undefined) args.query = string(query, 1_000);
      return normalizeObservation(
        await read("get_window_state", args),
        target,
        query !== undefined,
      );
    },
    async screenshot(requested) {
      const target = targetOf(requested);
      return screenshotImage(
        await call("get_window_state", {
          pid: target.pid,
          window_id: target.windowId,
          session,
          include_screenshot: true,
          include_accessibility_tree: false,
        }),
        target,
      );
    },
    async activate(requested) {
      const target = targetOf(requested);
      const { envelope, data } = structured(
        await call("bring_to_front", {
          pid: target.pid,
          window_id: target.windowId,
        }),
      );
      const exact = data?.exact_window_effect;
      if (
        envelope.isError ||
        !data ||
        data.pid !== target.pid ||
        data.window_id !== target.windowId ||
        data.status !== "activated" ||
        data.activated !== true ||
        !exact ||
        typeof exact !== "object" ||
        Array.isArray(exact) ||
        object(exact).verified !== true ||
        object(exact).focused !== true ||
        object(exact).frontmost_ordinary !== true
      ) {
        throw new Error(
          "Driver could not verify that the exact window is foreground",
        );
      }
      return { activated: true, target };
    },
    async visualScreenshot(requested) {
      const target = visualTargetOf(requested);
      if ("displayId" in target) {
        return screenshotImage(
          await call("get_desktop_state", { session }),
          target,
        );
      }
      return screenshotImage(
        await call("get_window_state", {
          pid: target.pid,
          window_id: target.windowId,
          session,
          include_screenshot: true,
          include_accessibility_tree: false,
        }),
        target,
      );
    },
    async visualExecute(action) {
      const target = visualTargetOf(action.target);
      if (action.kind === "press_key") {
        if ("displayId" in target)
          throw new Error("Select an exact window for keyboard input.");
        const parsed = parseKeyChord(action.key);
        const tool = schema("press_key");
        background(tool);
        const args: JsonObject = {
          ...windowArguments(tool, target),
          session,
          delivery_mode: "background",
          key: parsed.key,
        };
        if (parsed.modifiers.length) {
          requireFields(tool, ["modifiers"]);
          args.modifiers = parsed.modifiers;
        }
        return visualReceipt(await call("press_key", args));
      }
      const x = coordinate(action.x);
      const y = coordinate(action.y);
      if (!["click", "move", "type_text", "scroll"].includes(action.kind)) {
        throw new Error("Unsupported visual action");
      }
      const name = action.kind === "move" ? "move_cursor" : action.kind;
      const tool = schema(name);
      let args: JsonObject;
      if ("displayId" in target) {
        if (action.kind !== "click" && action.kind !== "move") {
          throw new Error(
            "Desktop visual input supports clicks and moves only",
          );
        }
        requireFields(tool, ["session", "target", "x", "y"]);
        args = {
          target: { kind: "desktop", display_id: "primary" },
          session,
          x,
          y,
        };
      } else {
        if (action.kind === "move") {
          requireFields(tool, ["session", "target", "x", "y"]);
          args = {
            target: {
              kind: "window",
              pid: target.pid,
              window_id: target.windowId,
            },
            session,
            x,
            y,
          };
        } else {
          background(tool);
          requireFields(tool, ["x", "y"]);
          args = {
            ...windowArguments(tool, target),
            session,
            delivery_mode: "background",
            x,
            y,
          };
        }
      }
      if (action.kind === "type_text") {
        args.text = string(action.text, 8_000);
      } else if (action.kind === "scroll") {
        if (!["up", "down", "left", "right"].includes(action.direction)) {
          throw new Error("Unsupported scroll direction");
        }
        const amount = action.amount ?? 3;
        if (!Number.isInteger(amount) || amount < 1 || amount > 50) {
          throw new Error("Scroll amount must be an integer from 1 to 50");
        }
        args.direction = action.direction;
        args.amount = amount;
        args.by = "line";
      }
      // Visual input has no independent effect proof. Never treat a transport
      // acknowledgement or native text readback as a verified page change.
      return visualReceipt(await call(name, args));
    },
    async execute(action) {
      const target = targetOf(action.target);
      const tool = schema(action.kind);
      const args: JsonObject = { ...windowArguments(tool, target), session };
      if (
        action.kind === "set_value" &&
        !Object.hasOwn(properties(tool), "delivery_mode")
      ) {
        // CUA's native set_value is an always-background semantic mutation.
        // Its schema intentionally has no delivery_mode. Do not inject one
        // or emulate replacement with focus/selection keyboard shortcuts.
        requireFields(tool, ["session", "element_token", "value"]);
      } else {
        background(tool);
        args.delivery_mode = "background";
      }
      let fields: JsonObject;
      if (action.kind === "press_key") {
        const parsed = parseKeyChord(action.key);
        fields = { key: parsed.key };
        if (parsed.modifiers.length) {
          requireFields(tool, ["modifiers"]);
          fields.modifiers = parsed.modifiers;
        }
      } else {
        requireFields(tool, ["element_token"]);
        const token = string(action.elementToken, 256);
        if (!token) throw new Error("An element token is required");
        fields = { element_token: token };
        if (action.kind === "type_text")
          fields.text = string(action.text, 16_384);
        if (action.kind === "set_value")
          fields.value = string(action.value, 16_384);
      }
      return normalizeReceipt(await call(action.kind, { ...args, ...fields }));
    },
    async close() {
      if (closed) return;
      closed = true;
      await client.close();
    },
  };
}

export async function connectDriver({
  command = process.env.CUA_DRIVER_BIN ??
    (process.platform === "darwin" &&
    existsSync("/Applications/CuaDriver.app/Contents/MacOS/cua-driver")
      ? "/Applications/CuaDriver.app/Contents/MacOS/cua-driver"
      : "cua-driver"),
  session,
}: { command?: string; session?: string } = {}): Promise<Driver> {
  const transport = new StdioClientTransport({
    command,
    args: ["mcp"],
    stderr: "ignore",
  });
  const client = new Client(
    { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    { jsonSchemaValidator: createDriverSchemaValidator() },
  );
  try {
    await client.connect(transport);
    return await createDriver(
      {
        listTools: (input) => client.listTools(input),
        callTool: (input) => client.callTool(input),
        close: () => client.close(),
        isConnected: () => client.transport !== undefined,
      },
      session,
    );
  } catch {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    throw new Error("Could not connect to Cua Driver");
  }
}
