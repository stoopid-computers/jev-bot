import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createSession } from "../../dist/index.js";
import type {
  Candidate,
  Choose,
  Driver,
  Element,
  NativeAction,
  Target,
} from "../../src/types.js";

export const target: Target = { pid: 123, windowId: 456 };
export const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh/8AAAAASUVORK5CYII=";

export function text(result: CallToolResult): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function decision(candidates: readonly Candidate[], selectedId: string) {
  assert.ok(candidates.some((candidate) => candidate.id === selectedId));
  return {
    selectedId,
    confidence: 1,
    probabilities: Object.fromEntries(
      candidates.map(({ id }) => [id, Number(id === selectedId)]),
    ),
  };
}

// An offline editor at the native Driver boundary. It records attempted input
// for no-replay assertions and exposes resulting text through observe().
export function desktopFixture(
  t: TestContext,
  overrides: Partial<Driver> = {},
  choose: Choose = async (_goal, _state, candidates) =>
    decision(candidates, "handoff"),
) {
  let sequence = 0;
  let caret = 0;
  let focused = 1;
  let elements: readonly Element[] = [
    {
      index: 1,
      role: "AXTextField",
      label: "Name",
      value: "",
      enabled: true,
      actions: ["AXPress"],
    },
    {
      index: 2,
      role: "AXButton",
      label: "Save",
      enabled: true,
      actions: ["AXPress"],
    },
  ];
  const actions: NativeAction[] = [];
  const observations: Array<{ target: Target; query?: string }> = [];
  const driver: Driver = {
    listApps: async () => ({
      apps: [
        {
          pid: 123,
          name: "Test Editor",
          bundle_id: "dev.test.editor",
          running: true,
        },
      ],
    }),
    listWindows: async () => ({
      windows: [
        { pid: 123, window_id: 456, title: "Document", is_on_screen: true },
      ],
    }),
    observe: async (selected, query) => {
      observations.push({ target: selected, query });
      const snapshotId = `snapshot-${++sequence}`;
      return {
        target: selected,
        snapshotId,
        appName: "Test Editor",
        windowTitle: "Document",
        elements: elements.map((element) => ({
          ...element,
          token: `${snapshotId}:${element.index}`,
        })),
        complete: true,
        degraded: false,
      };
    },
    screenshot: async () => ({ data: png, mimeType: "image/png" }),
    execute: async (action) => {
      actions.push(action);
      assert.deepEqual(action.target, target);
      if (action.kind === "press_key") {
        if (action.key === "left") caret = Math.max(0, caret - 1);
        if (action.key === "tab") focused = 2;
      } else {
        const element = elements.find(
          (item) =>
            `snapshot-${sequence}:${item.index}` === action.elementToken,
        );
        assert.ok(
          element,
          "input must use a token from the current observation",
        );
        focused = element.index;
        if (action.kind === "set_value") {
          elements = elements.map((item) =>
            item.index === focused ? { ...item, value: action.value } : item,
          );
          caret = action.value.length;
        } else if (action.kind === "type_text") {
          const value = element.value ?? "";
          elements = elements.map((item) =>
            item.index === focused
              ? {
                  ...item,
                  value:
                    value.slice(0, caret) + action.text + value.slice(caret),
                }
              : item,
          );
          caret += action.text.length;
        }
      }
      return { executed: true };
    },
    close: async () => {},
    ...overrides,
  };
  const session = createSession({ driver, choose });
  t.after(() => session.close());
  return {
    session,
    driver,
    actions,
    observations,
    setElements(this: void, value: readonly Element[]) {
      elements = value;
    },
  };
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
