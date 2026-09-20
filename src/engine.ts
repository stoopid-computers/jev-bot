import type {
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
import { parseKeyChord } from "./keys.js";

const KEYS = new Set([
  "return",
  "tab",
  "escape",
  "space",
  "backspace",
  "delete",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
]);
const EDITABLE_ROLES = new Set([
  "AXTextField",
  "AXTextArea",
  "AXSearchField",
  "AXComboBox",
]);
const MAX_CHOICES = 255;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function owned<T>(value: T): T {
  return freeze(structuredClone(value));
}

function validateTarget(target: Target): void {
  if (
    !target ||
    !Number.isSafeInteger(target.pid) ||
    target.pid <= 0 ||
    !Number.isSafeInteger(target.windowId) ||
    target.windowId < 0
  ) {
    throw new Error("Supply an observed process ID and window ID.");
  }
}

function validateRequest(request: RunRequest): void {
  validateTarget(request.target);
  if (
    typeof request.goal !== "string" ||
    !request.goal.trim() ||
    request.goal.length > 8_000
  ) {
    throw new Error("Supply a goal of 1 to 8000 characters.");
  }
  if (
    request.maxSteps !== undefined &&
    (!Number.isInteger(request.maxSteps) ||
      request.maxSteps < 1 ||
      request.maxSteps > 8)
  ) {
    throw new Error("maxSteps must be an integer from 1 to 8.");
  }
  if (
    request.minConfidence !== undefined &&
    (!Number.isFinite(request.minConfidence) ||
      request.minConfidence < 0 ||
      request.minConfidence > 1)
  ) {
    throw new Error("minConfidence must be a finite number from 0 to 1.");
  }
  if (
    request.text !== undefined &&
    (typeof request.text !== "string" || request.text.length > 8_000)
  ) {
    throw new Error("text must be a string of at most 8000 characters.");
  }
  if (
    request.query !== undefined &&
    (typeof request.query !== "string" || request.query.length > 1_000)
  ) {
    throw new Error("query must be a string of at most 1000 characters.");
  }
  if (
    request.keys !== undefined &&
    (!Array.isArray(request.keys) ||
      request.keys.length > 16 ||
      request.keys.some((key) => !KEYS.has(key)))
  ) {
    throw new Error(
      "Supply at most 16 supported native keys; shortcuts and arbitrary key strings are unsupported.",
    );
  }
  if (
    request.allowedKinds !== undefined &&
    (!Array.isArray(request.allowedKinds) ||
      request.allowedKinds.some(
        (kind) =>
          !["click", "type_text", "set_value", "press_key"].includes(kind),
      ))
  ) {
    throw new Error(
      "allowedKinds may contain only click, type_text, set_value, and press_key.",
    );
  }
  if (request.expect !== undefined) {
    const entries = Object.entries(request.expect);
    if (
      !entries.length ||
      entries.some(
        ([key, value]) =>
          !["role", "labelEquals", "valueEquals"].includes(key) ||
          typeof value !== "string",
      )
    ) {
      throw new Error(
        "expect needs at least one exact role, labelEquals, or valueEquals condition.",
      );
    }
    if (
      (!request.expect.role?.trim() && !request.expect.labelEquals?.trim()) ||
      (request.expect.valueEquals === undefined &&
        !request.expect.labelEquals?.trim())
    ) {
      throw new Error(
        "expect needs a role or label selector and an exact valueEquals or nonblank labelEquals condition.",
      );
    }
  }
}

function secure(element: Element): boolean {
  return (
    element.secure === true ||
    /password|secure/i.test(element.role) ||
    /password|passcode/i.test(element.label ?? "")
  );
}

function snapshot(observation: Observation, target: Target): Observation {
  if (
    !observation ||
    observation.target?.pid !== target.pid ||
    observation.target?.windowId !== target.windowId ||
    typeof observation.snapshotId !== "string" ||
    !observation.snapshotId ||
    !Array.isArray(observation.elements)
  ) {
    throw new Error(
      "The observation did not identify the requested window and snapshot.",
    );
  }
  return owned({
    ...observation,
    elements: observation.elements.map((element) =>
      secure(element) ? { ...element, value: undefined } : element,
    ),
  });
}

function matches(element: Element, expectation: Expectation): boolean {
  return (
    (expectation.role === undefined || element.role === expectation.role) &&
    (expectation.labelEquals === undefined ||
      element.label === expectation.labelEquals) &&
    (expectation.valueEquals === undefined ||
      element.value === expectation.valueEquals)
  );
}

function semanticState(observation: Observation): string {
  return JSON.stringify({
    target: observation.target,
    appName: observation.appName,
    windowTitle: observation.windowTitle,
    elements: observation.elements.map(
      ({ token: _token, index: _index, ...element }) => element,
    ),
  });
}

function candidatesFor(
  observation: Observation,
  request: RunRequest,
): readonly Candidate[] | string {
  const candidates: Candidate[] = [];
  const tokens = new Set<string>();
  const allows = (kind: NativeAction["kind"]) =>
    request.allowedKinds === undefined || request.allowedKinds.includes(kind);
  for (const element of observation.elements) {
    if (element.enabled !== true || element.inWebContent || secure(element))
      continue;
    const click = allows("click") && element.actions.includes("AXPress");
    const typeText =
      allows("type_text") &&
      request.text !== undefined &&
      EDITABLE_ROLES.has(element.role);
    // Replacement is an explicit host operation. General runs only offer
    // insertion unless the host asks for set_value in allowedKinds.
    const setValue =
      request.allowedKinds?.includes("set_value") &&
      request.text !== undefined &&
      EDITABLE_ROLES.has(element.role);
    if (!click && !typeText && !setValue) continue;
    if (!element.token || tokens.has(element.token)) {
      return "An actionable element has a missing or repeated native token. Observe again through the host.";
    }
    tokens.add(element.token);
    const description = `${element.role} ${JSON.stringify(element.label ?? "")} at observed index ${element.index}`;
    const add = (action: NativeAction, instruction: string) => {
      candidates.push({
        id: `action_${candidates.length + 1}`,
        description: `${instruction} ${description}`,
        action,
      });
    };
    if (click)
      add(
        {
          kind: "click",
          target: observation.target,
          elementToken: element.token,
        },
        "Press",
      );
    if (typeText)
      add(
        {
          kind: "type_text",
          target: observation.target,
          elementToken: element.token,
          text: request.text!,
        },
        "Insert the caller-supplied text at the current caret or selection in",
      );
    if (setValue)
      add(
        {
          kind: "set_value",
          target: observation.target,
          elementToken: element.token,
          value: request.text!,
        },
        "Replace the entire value with the caller-supplied text in",
      );
  }
  for (const key of new Set(allows("press_key") ? (request.keys ?? []) : [])) {
    candidates.push({
      id: `action_${candidates.length + 1}`,
      description: `Press the caller-supplied ${key} key in this window`,
      action: { kind: "press_key", target: observation.target, key },
    });
  }
  if (!candidates.length)
    return "No supported native actions are available. The host must inspect this state.";
  if (candidates.length + 3 > MAX_CHOICES) {
    return "This observation exceeds 255 choices. Narrow the observation query before continuing.";
  }
  candidates.push(
    {
      id: "reobserve",
      description:
        "Read this window again because its state is still changing.",
    },
    {
      id: "handoff",
      description:
        "Return control to the host because no offered action can safely make progress.",
    },
    {
      id: "done",
      description: "Return control to the host for completion verification.",
    },
  );
  return owned(candidates);
}

function validDecision(
  decision: Decision,
  candidates: readonly Candidate[],
  minConfidence: number,
): boolean {
  if (
    !decision ||
    typeof decision.selectedId !== "string" ||
    !Number.isFinite(decision.confidence) ||
    decision.confidence < minConfidence ||
    decision.confidence > 1 ||
    !decision.probabilities ||
    typeof decision.probabilities !== "object" ||
    Array.isArray(decision.probabilities)
  )
    return false;
  const ids = candidates.map((candidate) => candidate.id);
  const probabilities = decision.probabilities;
  if (
    !ids.includes(decision.selectedId) ||
    Object.keys(probabilities).length !== ids.length
  )
    return false;
  let total = 0;
  let largest = 0;
  for (const id of ids) {
    const probability = probabilities[id];
    if (
      !Object.hasOwn(probabilities, id) ||
      typeof probability !== "number" ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1
    )
      return false;
    total += probability;
    largest = Math.max(largest, probability);
  }
  return (
    Math.abs(total - 1) <= 0.02 &&
    probabilities[decision.selectedId]! >= largest - 0.000001
  );
}

/** One engine owns one native session. Calls fail while another call owns it. */
export class DesktopEngine {
  private busy = false;
  private closed = false;
  private closing = false;
  private idle: Promise<void> = Promise.resolve();
  private driverClosePromise?: Promise<void>;
  private shutdownPromise?: Promise<void>;

  constructor(
    private readonly driver: Driver,
    private readonly choose: Choose,
  ) {}

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("Desktop engine is closed.");
    if (this.closing) throw new Error("Desktop engine is shutting down.");
    if (this.busy)
      throw new Error(
        "Desktop engine is busy. Wait for the current call to finish.",
      );
    this.busy = true;
    let release!: () => void;
    // This promise tracks ownership, not the operation's result. It always
    // resolves, including when the caller receives an operation error.
    this.idle = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      return await operation();
    } finally {
      this.busy = false;
      release();
    }
  }

  async listWindows(): Promise<JsonObject> {
    return this.exclusive(async () => owned(await this.driver.listWindows()));
  }

  async configureCursor(
    options: Parameters<NonNullable<Driver["configureCursor"]>>[0],
  ): Promise<JsonObject> {
    return this.exclusive(async () => {
      if (!this.driver.configureCursor)
        throw new Error("This driver cannot configure its cursor.");
      return owned(await this.driver.configureCursor(owned(options)));
    });
  }

  async listApps(): Promise<JsonObject> {
    return this.exclusive(async () => {
      if (!this.driver.listApps)
        throw new Error("This native driver does not support listing apps.");
      return owned(await this.driver.listApps());
    });
  }

  async screenshot(
    target: Target,
  ): Promise<{ data: string; mimeType: string }> {
    return this.exclusive(async () => {
      validateTarget(target);
      if (!this.driver.screenshot)
        throw new Error("This native driver does not support screenshots.");
      return owned(await this.driver.screenshot(owned(target)));
    });
  }

  async activate(target: Target): Promise<JsonObject> {
    return this.exclusive(async () => {
      validateTarget(target);
      if (!this.driver.activate)
        throw new Error("This driver cannot activate an exact window.");
      return owned(await this.driver.activate(owned(target)));
    });
  }

  async visualScreenshot(
    target: VisualTarget,
  ): Promise<{ data: string; mimeType: string }> {
    return this.exclusive(async () => {
      if (!this.driver.visualScreenshot)
        throw new Error("This driver cannot capture visual targets.");
      return owned(await this.driver.visualScreenshot(owned(target)));
    });
  }

  async visualExecute(action: VisualAction): Promise<JsonObject> {
    return this.exclusive(async () => {
      if (!this.driver.visualExecute)
        throw new Error("This driver cannot send screenshot-based input.");
      try {
        return owned(await this.driver.visualExecute(owned(action)));
      } catch {
        return owned({
          executed: false,
          execution: "unknown",
          reason:
            "Visual input was interrupted. Inspect a fresh screenshot before continuing. Do not retry automatically.",
        });
      }
    });
  }

  async execute(action: NativeAction): Promise<JsonObject> {
    return this.exclusive(async () => {
      validateTarget(action.target);
      if (action.kind === "press_key") {
        parseKeyChord(action.key);
      } else if (
        action.kind === "click" ||
        action.kind === "type_text" ||
        action.kind === "set_value"
      ) {
        if (typeof action.elementToken !== "string" || !action.elementToken)
          throw new Error("An observed native element token is required.");
        if (
          action.kind === "type_text" &&
          (typeof action.text !== "string" || action.text.length > 8_000)
        ) {
          throw new Error("text must be a string of at most 8000 characters.");
        }
        if (
          action.kind === "set_value" &&
          (typeof action.value !== "string" || action.value.length > 8_000)
        ) {
          throw new Error("value must be a string of at most 8000 characters.");
        }
      } else {
        throw new Error("This native action is unsupported.");
      }
      // The host maps its latest observed element to this token. The native
      // driver owns the final freshness and supported-action check.
      try {
        return owned(await this.driver.execute(owned(action)));
      } catch {
        return owned({
          executed: false,
          outcome: "unknown",
          reason: "Native execution was interrupted. Inspect before retrying.",
        });
      }
    });
  }

  async observe(target: Target, query?: string): Promise<Observation> {
    return this.exclusive(async () => {
      validateTarget(target);
      const selected = owned(target);
      return snapshot(await this.driver.observe(selected, query), selected);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return this.driverClosePromise;
    return this.exclusive(() => this.closeDriver());
  }

  private closeDriver(): Promise<void> {
    if (!this.driverClosePromise) {
      this.closed = true;
      // Defer invocation so synchronous driver errors also belong to the one
      // shared close promise. A failed close is reported, never retried.
      this.driverClosePromise = Promise.resolve().then(() =>
        this.driver.close(),
      );
    }
    return this.driverClosePromise;
  }

  /** Process teardown stops admission, drains the active call, then closes once. */
  shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.closing = true;
      const active = this.idle;
      this.shutdownPromise = (async () => {
        await active;
        await this.closeDriver();
      })();
    }
    return this.shutdownPromise;
  }

  async run(input: RunRequest, signal?: AbortSignal): Promise<RunResult> {
    return this.exclusive(async () => {
      validateRequest(input);
      const request = owned(input);
      const history: JsonObject[] = [];
      let observation: Observation | undefined;
      const finish = (status: RunResult["status"], reason: string): RunResult =>
        owned({ status, reason, history, observation });
      const observe = async () => {
        // Once a new read starts, the previous handles are no longer current.
        // A failed read must not publish those handles as the action's result.
        observation = undefined;
        observation = snapshot(
          await this.driver.observe(request.target, request.query),
          request.target,
        );
      };
      const inspect = (): RunResult | undefined => {
        if (
          !observation ||
          observation.degraded ||
          !observation.elements.length
        ) {
          return finish(
            "handoff",
            "The native accessibility observation is degraded or has no supported elements. The host must inspect it.",
          );
        }
        if (request.expect) {
          // Native AX observations project useful elements and may be partial.
          // They can prove a positive observed predicate, never absence or
          // uniqueness outside the returned window elements.
          const selector = {
            role: request.expect.role,
            labelEquals: request.expect.labelEquals,
          };
          const selected = observation.elements.filter((element) =>
            matches(element, selector),
          );
          if (selected.length > 1)
            return finish(
              "handoff",
              "The completion selector matches multiple observed elements. Supply a more specific selector.",
            );
          if (selected.length === 1 && matches(selected[0]!, request.expect)) {
            return finish(
              "verified",
              "The exact positive predicate matched one selector candidate within the returned window elements.",
            );
          }
        }
        return undefined;
      };
      if (signal?.aborted)
        return finish("cancelled", "Cancelled before observing or executing.");
      try {
        await observe();
      } catch {
        return finish(
          "unknown",
          "The native observation failed. No action was attempted.",
        );
      }
      for (let step = 1; step <= (request.maxSteps ?? 4); step++) {
        if (signal?.aborted)
          return finish("cancelled", "Cancelled before the next action.");
        const inspected = inspect();
        if (inspected) return inspected;
        const current = observation!;
        const candidates = candidatesFor(current, request);
        if (typeof candidates === "string")
          return finish("handoff", candidates);
        let decision: Decision;
        try {
          decision = await this.choose(
            request.goal,
            current,
            candidates,
            owned(history),
            signal,
          );
        } catch {
          return finish(
            signal?.aborted ? "cancelled" : "handoff",
            "The decision request stopped. No action was executed in this step.",
          );
        }
        if (signal?.aborted)
          return finish("cancelled", "Cancelled before execution.");
        if (
          !validDecision(decision, candidates, request.minConfidence ?? 0.7)
        ) {
          return finish(
            "handoff",
            "The decision was invalid or below the required confidence. No action was executed in this step.",
          );
        }
        const selected = candidates.find(
          (candidate) => candidate.id === decision.selectedId,
        )!;
        const entry: JsonObject = {
          step,
          snapshotId: current.snapshotId,
          selectedId: selected.id,
          confidence: decision.confidence,
        };
        if (!selected.action) {
          history.push({ ...entry, outcome: selected.id });
          if (selected.id !== "reobserve") {
            return finish(
              "handoff",
              selected.id === "done"
                ? "The model chose done. The host must verify completion; no exact observation condition was met."
                : "The model returned control to the host.",
            );
          }
          try {
            await observe();
          } catch {
            return finish(
              "unknown",
              "The requested observation failed. No mutation was retried.",
            );
          }
          continue;
        }
        let receipt: JsonObject | undefined;
        let interrupted = false;
        try {
          receipt = await this.driver.execute(selected.action);
        } catch {
          interrupted = true;
        }
        const cancelledDuringMutation = signal?.aborted === true;
        const confirmed =
          !interrupted && receipt?.executed === true && receipt?.stale !== true;
        const stale =
          !interrupted &&
          (receipt?.stale === true || receipt?.status === "stale");
        history.push({
          ...entry,
          kind: selected.action.kind,
          outcome: cancelledDuringMutation
            ? "unknown"
            : stale
              ? "stale"
              : confirmed
                ? "executed"
                : "unknown",
          ...(receipt ? { receipt: owned(receipt) } : {}),
        });
        // Every attempted mutation is recorded before its one read-only follow-up.
        // A transport failure is never permission to repeat the mutation.
        try {
          await observe();
        } catch {
          return finish(
            "unknown",
            "The action was attempted, but its fresh result could not be observed. Do not retry it without inspection.",
          );
        }
        if (cancelledDuringMutation)
          return finish(
            "unknown",
            "Cancelled while native input was in flight. Inspect the fresh observation before continuing.",
          );
        const after = inspect();
        if (after?.status === "verified") return after;
        if (stale)
          return finish(
            "handoff",
            "The native target became stale. No mutation was retried.",
          );
        if (!confirmed)
          return finish(
            "unknown",
            "Native execution was not confirmed and the completion condition was not met. No mutation was retried.",
          );
        if (after) return after;
        if (signal?.aborted)
          return finish(
            "cancelled",
            "Cancelled after the action and its fresh observation.",
          );
        if (semanticState(current) === semanticState(observation!)) {
          return finish(
            "handoff",
            "The action produced no observed accessibility change. The host must inspect before another action.",
          );
        }
      }
      const last = inspect();
      if (last) return last;
      return finish(
        "budget_exhausted",
        "The decision budget is exhausted. The final observation is available for the host.",
      );
    });
  }
}
