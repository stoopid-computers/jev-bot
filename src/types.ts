/** An object-shaped driver payload or action history entry. */
export type JsonObject = Record<string, unknown>;

/** An observed native window and the process that owns it. */
export type Target = Readonly<{
  /** Process ID from the app or window inventory. */
  pid: number;
  /** Native window ID from the window inventory. */
  windowId: number;
}>;

/** Exact window or primary display selected for screenshot-grounded input. */
export type VisualTarget = Target | Readonly<{ displayId: "primary" }>;

/** One host-chosen input grounded in the latest target screenshot. */
export type VisualAction = Readonly<
  | {
      /** Send a key or shortcut to the selected window's focused control. */
      kind: "press_key";
      /** Exact window receiving the key. Desktop keyboard input is unsupported. */
      target: Target;
      /** One key or chord, such as Return or Cmd+K. */
      key: string;
    }
  | ({
      /** Screenshot that supplies the coordinate space. */
      target: VisualTarget;
      /** Horizontal pixel coordinate in the returned PNG. */
      x: number;
      /** Vertical pixel coordinate in the returned PNG. */
      y: number;
    } & (
      | { /** Click once with the left button. */ kind: "click" }
      | {
          /** Hover within an exact window, or move the pointer on an explicit desktop. */
          kind: "move";
        }
      | {
          /** Click the field and insert exact caller-provided text. */
          kind: "type_text";
          /** Text to insert, at most 8,000 characters. */
          text: string;
        }
      | {
          /** Send wheel input at the chosen point. */
          kind: "scroll";
          /** Direction in which to scroll the content. */
          direction: "up" | "down" | "left" | "right";
          /** Wheel notches from 1 to 50. Defaults to 3. */
          amount?: number;
        }
    ))
>;

/** A control returned by a native accessibility observation. */
export type Element = Readonly<{
  /** Opaque native handle for actions against this observed control. */
  token?: string;
  /** Element number in this observation. Read fresh state after input. */
  index: number;
  /** Accessibility role, such as `AXButton` or `AXTextField`. */
  role: string;
  /** Accessibility label, when the app provides one. */
  label?: string;
  /** Observed value. Secure field values are removed before use. */
  value?: string;
  /** Whether the app reports that this control accepts input. */
  enabled?: boolean;
  /** Marks a sensitive control that must not receive automated input. */
  secure?: boolean;
  /** Accessibility actions supported by the control, such as `AXPress`. */
  actions: readonly string[];
  /** Marks web content, which native action selection excludes. */
  inWebContent?: boolean;
}>;

/** Accessibility state from one read of a selected native window. */
export type Observation = Readonly<{
  /** Window that produced this observation. */
  target: Target;
  /** Identifies the read that supplied the element numbers and tokens. */
  snapshotId: string;
  /** App name, or an empty string when unavailable. */
  appName: string;
  /** Window title, or an empty string when unavailable. */
  windowTitle: string;
  /** Controls returned by this read, which may cover only part of the window. */
  elements: readonly Element[];
  /** Whether the driver reports a full read with no filtering or redaction. */
  complete: boolean;
  /** Whether accessibility data is impaired and requires host inspection. */
  degraded: boolean;
}>;

/**
 * One supported native input operation.
 * Element actions use a token from the latest observation of the target window.
 * Text comes from the caller; the chooser never generates input text.
 */
export type NativeAction = Readonly<
  | {
      /** Press the control through its native accessibility action. */
      kind: "click";
      /** Window containing the control. */
      target: Target;
      /** Native handle from the latest observation. */
      elementToken: string;
    }
  | {
      /** Insert text at the current caret or selection. */
      kind: "type_text";
      /** Window containing the editable control. */
      target: Target;
      /** Native handle from the latest observation. */
      elementToken: string;
      /** Exact text to insert. */
      text: string;
    }
  | {
      /** Replace the control's entire value. */
      kind: "set_value";
      /** Window containing the editable control. */
      target: Target;
      /** Native handle from the latest observation. */
      elementToken: string;
      /** Exact replacement value. */
      value: string;
    }
  | {
      /** Send one supported key or shortcut to the window. */
      kind: "press_key";
      /** Window receiving the key. */
      target: Target;
      /** Key or chord, such as `return`, `tab`, or `Cmd+K`. */
      key: string;
    }
>;

/** An offered native action or a request to reobserve or return control. */
export type Candidate = Readonly<{
  /** Unique choice ID, also used in the decision's probability map. */
  id: string;
  /** Explanation of what selecting this candidate will do. */
  description: string;
  /** Input to execute; absent for `reobserve`, `handoff`, and `done`. */
  action?: NativeAction;
}>;

/** The chooser's selection from the current candidate list. */
export type Decision = Readonly<{
  /** ID of an offered candidate with the highest returned probability. */
  selectedId: string;
  /** Reported confidence from zero to one. */
  confidence: number;
  /** Probability for every offered ID, from zero to one and totaling about one. */
  probabilities: Readonly<Record<string, number>>;
  /** Model name reported by the provider, when available. */
  model?: string;
}>;

/**
 * Native desktop adapter owned by a computer-use session.
 * Implement this interface to supply a driver or an offline test double.
 */
export interface Driver {
  /** List running apps. App discovery is unavailable when omitted. */
  listApps?(): Promise<JsonObject>;
  /** List native windows, including their process and window IDs. */
  listWindows(): Promise<JsonObject>;
  /** Read a window's accessibility state, optionally filtered by a query. */
  observe(target: Target, query?: string): Promise<Observation>;
  /** Capture the window as base64 PNG data with MIME type `image/png`. */
  screenshot?(target: Target): Promise<{ data: string; mimeType: string }>;
  /** Bring this exact window forward and verify its native focus and order. */
  activate?(target: Target): Promise<JsonObject>;
  /** Capture a window or the primary display for host-chosen pixel input. */
  visualScreenshot?(
    target: VisualTarget,
  ): Promise<{ data: string; mimeType: string }>;
  /**
   * Attempt background window input, or an explicit desktop click or move.
   * The host must inspect a fresh screenshot to verify the resulting change.
   */
  visualExecute?(action: VisualAction): Promise<JsonObject>;
  /** Configure this connection's cursor appearance and movement without input. */
  configureCursor?(options: {
    /** ID of an already-installed native cursor theme. */
    themeId?: string;
    /** Glide duration from 0 to 5,000 milliseconds; zero uses speed-based motion. */
    glideDurationMs?: number;
    /** Pause after a click, from 0 to 5,000 milliseconds. */
    dwellAfterClickMs?: number;
    /** Idle visibility interval from 0 to 60,000 milliseconds. */
    idleHideMs?: number;
  }): Promise<JsonObject>;
  /**
   * Perform one input operation and return its receipt.
   * Set `executed: true` only for confirmed execution; report stale targets
   * with `stale: true`. An uncertain result must not trigger an input retry.
   */
  execute(action: NativeAction): Promise<JsonObject>;
  /** Close the native connection and release its resources. */
  close(): Promise<void>;
}

/**
 * Select an offered candidate using the current window state and prior steps.
 * The session validates the decision before executing a native action.
 *
 * @param goal Caller-supplied task description.
 * @param observation Latest accessibility state for the target window.
 * @param candidates Allowed choices, including choices that perform no input.
 * @param history Decisions and attempted actions from this run.
 * @param signal Cancellation signal for the selection request.
 * @returns A selection and probability for every offered candidate.
 */
export type Choose = (
  goal: string,
  observation: Observation,
  candidates: readonly Candidate[],
  history: readonly JsonObject[],
  signal?: AbortSignal,
) => Promise<Decision>;

/**
 * Exact observed conditions required to report a run as verified.
 * Select a control with `role` or `labelEquals`, then check `valueEquals`.
 * A nonblank `labelEquals` can also stand alone. All supplied fields must match
 * one returned element, and the selector must not match multiple elements.
 */
export type Expectation = Readonly<{
  /** Exact accessibility role to select. A role alone cannot verify success. */
  role?: string;
  /** Exact accessibility label to select and verify. */
  labelEquals?: string;
  /** Exact observed value required on the selected control. */
  valueEquals?: string;
}>;

/** Inputs and limits for one bounded action-selection run. */
export type RunRequest = Readonly<{
  /** Nonblank task description of at most 8,000 characters. */
  goal: string;
  /** Observed window in which every action and follow-up read takes place. */
  target: Target;
  /** Exact text available for insertion or replacement, up to 8,000 characters. */
  text?: string;
  /** Up to 16 supported lowercase key names the chooser may select. */
  keys?: readonly string[];
  /** Accessibility filter of at most 1,000 characters, applied to every read. */
  query?: string;
  /** Exact observed conditions for success. Model completion alone is insufficient. */
  expect?: Expectation;
  /** Decision limit from 1 to 8, including reobserve choices. Defaults to 4. */
  maxSteps?: number;
  /** Minimum accepted chooser confidence from zero to one. Defaults to 0.7. */
  minConfidence?: number;
  /**
   * Restrict available input kinds. Omission allows supported clicks, insertion,
   * and supplied keys. Replacement requires explicitly including `set_value`.
   */
  allowedKinds?: readonly NativeAction["kind"][];
}>;

/** A run's stopping reason and the observed evidence available to the host. */
export type RunResult = Readonly<{
  /**
   * `verified` means the exact expectation matched one returned element.
   * `handoff` needs host inspection; `budget_exhausted` reached the step limit.
   * `unknown` means observation or input was uncertain. `cancelled` stopped
   * before further input, but earlier actions may have occurred.
   */
  status: "verified" | "handoff" | "budget_exhausted" | "unknown" | "cancelled";
  /** Explanation of why the run stopped and what the host should inspect. */
  reason: string;
  /** Decisions and attempted actions, including their receipts when available. */
  history: readonly JsonObject[];
  /** Latest successful read; absent when no current observation is available. */
  observation?: Observation;
}>;
