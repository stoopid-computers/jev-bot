import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { z } from "zod";
import { createSession } from "../dist/index.js";
import { text } from "./helpers/desktop.js";
import type {
  Candidate,
  Choose,
  Decision,
  Driver,
  Element,
  JsonObject,
  NativeAction,
  Observation,
  RunRequest,
} from "../src/types.js";

const target = { pid: 42, windowId: 7 };
const button: Element = {
  index: 1,
  token: "token-1",
  role: "AXButton",
  label: "Save",
  enabled: true,
  actions: ["AXPress"],
};
const field: Element = {
  index: 2,
  token: "token-2",
  role: "AXTextField",
  label: "Name",
  value: "",
  enabled: true,
  actions: [],
};
const request: RunRequest = { goal: "Save the document", target };

function observation(
  elements: readonly Element[] = [button, field],
  extra: Partial<Observation> = {},
): Observation {
  return {
    target,
    snapshotId: "snapshot-1",
    appName: "Test app",
    windowTitle: "Document",
    complete: true,
    degraded: false,
    elements,
    ...extra,
  };
}

class FakeDriver implements Driver {
  reads = 0;
  executed: NativeAction[] = [];
  receipt: JsonObject = { executed: true };
  executeHook?: (action: NativeAction) => Promise<JsonObject>;
  observeHook?: () => Promise<Observation>;

  constructor(
    readonly observations: readonly (Observation | Error)[] = [observation()],
  ) {}

  async listWindows(): Promise<JsonObject> {
    return { windows: [target] };
  }

  async observe(): Promise<Observation> {
    this.reads++;
    if (this.reads === 1) return observation(); // Initial window selection.
    if (this.observeHook) return this.observeHook();
    const result =
      this.observations[
        Math.min(this.reads - 2, this.observations.length - 1)
      ]!;
    if (result instanceof Error) throw result;
    return result;
  }

  async execute(action: NativeAction): Promise<JsonObject> {
    this.executed.push(action);
    return this.executeHook ? this.executeHook(action) : this.receipt;
  }

  async close(): Promise<void> {}
}

function answer(
  candidates: readonly Candidate[],
  selectedId = candidates[0]!.id,
): Decision {
  return {
    selectedId,
    confidence: 1,
    probabilities: Object.fromEntries(
      candidates.map((candidate) => [
        candidate.id,
        Number(candidate.id === selectedId),
      ]),
    ),
  };
}

const chooseFirst: Choose = async (_goal, _observation, candidates) =>
  answer(candidates);

const runResult = z.object({
  status: z.enum([
    "verified",
    "handoff",
    "unknown",
    "cancelled",
    "budget_exhausted",
  ]),
  reason: z.string(),
  history: z.array(z.record(z.unknown())),
  observation: z
    .object({
      snapshotId: z.string(),
      complete: z.boolean(),
      elements: z.array(z.object({ label: z.string().optional() })),
    })
    .optional(),
});

// Run through the same public API used by an MCP host. Only the external
// native Driver and Jev Choose contracts are replaced.
function taskSession(t: TestContext, driver: Driver, choose: Choose) {
  let chooserAssertion: unknown;
  const session = createSession({
    driver,
    choose: async (...args) => {
      try {
        return await choose(...args);
      } catch (error) {
        if (error instanceof assert.AssertionError) chooserAssertion = error;
        throw error;
      }
    },
  });
  t.after(() => session.close());
  let selected = false;
  return {
    async act(request: RunRequest) {
      if (!selected) {
        const setup = await session.execute(
          `let app = await cua.getWindow(${request.target.pid},${request.target.windowId});`,
        );
        assert.notEqual(setup.isError, true, text(setup));
        selected = true;
      }
      const { goal, target: _target, ...options } = request;
      const response = await session.execute(
        `await app.act(${JSON.stringify(goal)},${JSON.stringify(options)});`,
      );
      if (chooserAssertion) throw chooserAssertion;
      if (response.isError) throw new Error(text(response));
      const result = runResult.parse(JSON.parse(text(response)));
      return result;
    },
  };
}

void test("matches a unique exact postcondition before any provider call or mutation", async (t) => {
  const driver = new FakeDriver();
  const app = taskSession(t, driver, async () => {
    assert.fail("must not call provider");
  });
  const result = await app.act({
    ...request,
    expect: { role: "AXTextField", labelEquals: "Name", valueEquals: "" },
  });
  assert.equal(result.status, "verified");
  assert.equal(driver.executed.length, 0);
});

void test("empty and ambiguous completion conditions cannot report success", async (t) => {
  const driver = new FakeDriver([
    observation([button, { ...button, token: "other", index: 3 }]),
  ]);
  const app = taskSession(t, driver, chooseFirst);
  await assert.rejects(app.act({ ...request, expect: {} }), /exact/);
  await assert.rejects(
    app.act({ ...request, expect: { valueEquals: "Save" } }),
    /selector/,
  );
  await assert.rejects(
    app.act({ ...request, expect: { role: "AXButton" } }),
    /selector/,
  );
  const result = await app.act({
    ...request,
    expect: { labelEquals: "Save" },
  });
  assert.equal(result.status, "handoff");
  assert.match(result.reason, /multiple/);
  assert.equal(driver.executed.length, 0);
});

void test("model done always hands verification to the host without a matching condition", async (t) => {
  const driver = new FakeDriver();
  const app = taskSession(t, driver, async (_goal, _state, candidates) =>
    answer(candidates, "done"),
  );
  const result = await app.act(request);
  assert.equal(result.status, "handoff");
  assert.match(result.reason, /model chose done/);
  assert.equal(driver.executed.length, 0);
});

void test("unknown execution returns a fresh observation without replaying input", async (t) => {
  for (const failure of ["throw", "unknown", "stale"] as const) {
    await t.test(failure, async (t) => {
      const driver = new FakeDriver([
        observation(),
        observation([field], { snapshotId: "after-attempt" }),
      ]);
      if (failure === "throw")
        driver.executeHook = async () => {
          throw new Error("connection dropped");
        };
      else
        driver.receipt =
          failure === "stale" ? { stale: true } : { accepted: true };
      const app = taskSession(t, driver, chooseFirst);
      const result = await app.act(request);
      assert.equal(result.status, failure === "stale" ? "handoff" : "unknown");
      assert.equal(driver.executed.length, 1);
      assert.equal(result.observation?.snapshotId, "after-attempt");
      assert.equal(result.history.length, 1);
    });
  }
});

void test("observed text resolves a lost execution response without repeating insertion", async (t) => {
  let value = "";
  const driver = new FakeDriver();
  driver.observeHook = async () => observation([{ ...field, value }]);
  driver.executeHook = async (action) => {
    if (action.kind === "type_text" && action.elementToken === "token-2")
      value += action.text;
    throw new Error("response lost after input");
  };
  const result = await taskSession(
    t,
    driver,
    async (_goal, _state, candidates) => {
      const insertion = candidates.find(
        (candidate) => candidate.action?.kind === "type_text",
      );
      assert.ok(insertion);
      return answer(candidates, insertion.id);
    },
  ).act({
    goal: "Fill Name",
    target,
    text: "Saved",
    expect: { labelEquals: "Name", valueEquals: "Saved" },
  });
  assert.equal(result.status, "verified");
  assert.equal(result.history[0]?.outcome, "unknown");
  assert.equal(driver.executed.length, 1);
});

void test("failed postobservation preserves the attempted action and stops", async (t) => {
  const driver = new FakeDriver([observation(), new Error("read failed")]);
  const result = await taskSession(t, driver, chooseFirst).act(request);
  assert.equal(result.status, "unknown");
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0]?.outcome, "executed");
  assert.equal(driver.executed.length, 1);
  assert.equal(result.observation, undefined);
});

void test("unchanged semantic state stops before repeating a confirmed action", async (t) => {
  const driver = new FakeDriver([
    observation(),
    observation(
      [
        { ...button, token: "fresh-token" },
        { ...field, token: "fresh-field" },
      ],
      { snapshotId: "new-id" },
    ),
  ]);
  let decisions = 0;
  const app = taskSession(t, driver, async (...args) => {
    decisions++;
    return chooseFirst(...args);
  });
  const result = await app.act(request);
  assert.equal(result.status, "handoff");
  assert.match(result.reason, /no observed accessibility change/);
  assert.equal(decisions, 1);
  assert.equal(driver.executed.length, 1);
});

void test("reobservation consumes the budget and the final read can verify completion", async (t) => {
  const driver = new FakeDriver([
    observation(),
    observation(),
    observation([{ ...field, value: "Ready" }]),
  ]);
  const app = taskSession(t, driver, async (_goal, _state, candidates) =>
    answer(candidates, "reobserve"),
  );
  const result = await app.act({
    ...request,
    maxSteps: 2,
    expect: { labelEquals: "Name", valueEquals: "Ready" },
  });
  assert.equal(result.status, "verified");
  assert.equal(result.history.length, 2);
  assert.equal(driver.executed.length, 0);
  const exhausted = await taskSession(
    t,
    new FakeDriver(),
    async (_goal, _state, candidates) => answer(candidates, "reobserve"),
  ).act({ ...request, maxSteps: 2 });
  assert.equal(exhausted.status, "budget_exhausted");
  assert.equal(exhausted.history.length, 2);
});

void test("only advertised enabled native actions and caller-supplied text become candidates", async (t) => {
  const elements: Element[] = [
    button,
    field,
    { ...button, token: "disabled", index: 3, enabled: false },
    { ...button, token: "web", index: 4, inWebContent: true },
    {
      ...field,
      token: "password",
      index: 5,
      label: "Password",
      value: "secret",
    },
    {
      ...field,
      token: "secure",
      index: 6,
      label: "Code",
      secure: true,
      value: "secret",
    },
    { ...button, token: "unknown", index: 7, actions: ["AXShowMenu"] },
    { ...field, token: "unadvertised", index: 8, role: "AXStaticText" },
    { ...button, token: "not-known-enabled", index: 9, enabled: undefined },
  ];
  const driver = new FakeDriver([observation(elements)]);
  const seen: Candidate[][] = [];
  const app = taskSession(t, driver, async (_goal, state, candidates) => {
    seen.push([...candidates]);
    assert.equal(
      state.elements.find((element) => element.token === "password")?.value,
      undefined,
    );
    assert.equal(
      state.elements.find((element) => element.token === "secure")?.value,
      undefined,
    );
    return answer(candidates, "handoff");
  });
  await app.act(request);
  await app.act({ ...request, text: "Exact caller text" });
  assert.deepEqual(
    seen[0]!.flatMap((candidate) =>
      candidate.action ? [candidate.action.kind] : [],
    ),
    ["click"],
  );
  const actions = seen[1]!.flatMap((candidate) =>
    candidate.action ? [candidate.action] : [],
  );
  assert.equal(actions.length, 2);
  assert.deepEqual(actions[1], {
    kind: "type_text",
    target,
    elementToken: "token-2",
    text: "Exact caller text",
  });
});

void test("keys are scoped to the supplied allowlist and invalid strings fail before native calls", async (t) => {
  const driver = new FakeDriver();
  let offered: readonly Candidate[] = [];
  const app = taskSession(t, driver, async (_goal, _state, candidates) => {
    offered = candidates;
    return answer(candidates, "handoff");
  });
  await app.act({ ...request, keys: ["return", "tab", "return"] });
  assert.deepEqual(
    offered.flatMap((candidate) =>
      candidate.action?.kind === "press_key" ? [candidate.action.key] : [],
    ),
    ["return", "tab"],
  );
  const readsBefore = driver.reads;
  await assert.rejects(
    app.act({ ...request, keys: ["command+q"] }),
    /supported native keys/,
  );
  assert.equal(driver.reads, readsBefore);
});

void test("missing or repeated actionable tokens return to the host", async (t) => {
  for (const elements of [
    [{ ...button, token: undefined }],
    [button, { ...button, index: 2 }],
  ]) {
    await t.test(JSON.stringify(elements), async (t) => {
      let called = false;
      const driver = new FakeDriver([observation(elements)]);
      const result = await taskSession(t, driver, async (...args) => {
        called = true;
        return chooseFirst(...args);
      }).act(request);
      assert.equal(result.status, "handoff");
      assert.match(result.reason, /token/);
      assert.equal(called, false);
    });
  }
});

void test("candidate overflow hands off instead of truncating supported choices", async (t) => {
  const elements = Array.from({ length: 253 }, (_, index) => ({
    ...button,
    index,
    token: `token-${index}`,
  }));
  const driver = new FakeDriver([observation(elements)]);
  const result = await taskSession(t, driver, async () => {
    assert.fail("must not call provider");
  }).act(request);
  assert.equal(result.status, "handoff");
  assert.match(result.reason, /255/);
  assert.equal(driver.executed.length, 0);
  const bounded = new FakeDriver([observation(elements.slice(0, 252))]);
  await taskSession(t, bounded, async (_goal, _state, candidates) => {
    assert.equal(candidates.length, 255);
    return answer(candidates, "handoff");
  }).act(request);
});

void test("degraded or empty accessibility trees cannot verify or execute", async (t) => {
  for (const state of [
    observation([button], { degraded: true }),
    observation([]),
  ]) {
    await t.test(JSON.stringify(state), async (t) => {
      const driver = new FakeDriver([state]);
      const result = await taskSession(t, driver, async () => {
        assert.fail("must not call provider");
      }).act({ ...request, expect: { labelEquals: "Save" } });
      assert.equal(result.status, "handoff");
      assert.equal(driver.executed.length, 0);
    });
  }
});

void test("partial accessibility can verify an observed text edit without claiming a complete tree", async (t) => {
  let value = "";
  const driver = new FakeDriver();
  driver.observeHook = async () =>
    observation([{ ...field, value }], { complete: false });
  driver.executeHook = async (action) => {
    if (action.kind === "type_text" && action.elementToken === "token-2")
      value += action.text;
    return { executed: true };
  };
  const result = await taskSession(
    t,
    driver,
    async (_goal, _state, candidates) => {
      const insertion = candidates.find(
        (candidate) => candidate.action?.kind === "type_text",
      );
      assert.ok(insertion);
      return answer(candidates, insertion.id);
    },
  ).act({
    goal: "Fill Name",
    target,
    text: "Saved",
    expect: { labelEquals: "Name", valueEquals: "Saved" },
  });
  assert.equal(result.status, "verified");
  assert.equal(result.observation?.complete, false);
});

void test("an absent predicate on a partial projection never counts as verification", async (t) => {
  const driver = new FakeDriver([observation([button], { complete: false })]);
  const result = await taskSession(
    t,
    driver,
    async (_goal, _state, candidates) => answer(candidates, "done"),
  ).act({
    ...request,
    expect: { role: "AXTextField", labelEquals: "Name", valueEquals: "Saved" },
  });
  assert.equal(result.status, "handoff");
});

void test("different values cannot disambiguate two elements with the same completion selector", async (t) => {
  const driver = new FakeDriver([
    observation(
      [
        { ...field, value: "Saved" },
        { ...field, index: 3, token: "other-field", value: "Unsaved" },
      ],
      { complete: false },
    ),
  ]);
  const result = await taskSession(t, driver, chooseFirst).act({
    ...request,
    expect: { role: "AXTextField", labelEquals: "Name", valueEquals: "Saved" },
  });
  assert.equal(result.status, "handoff");
  assert.match(result.reason, /selector matches multiple/);
  assert.equal(driver.executed.length, 0);
});

void test("invalid decisions cannot reach native execution", async (t) => {
  const mutations: Record<string, (value: Decision) => Decision> = {
    "unknown choice": (value) => ({ ...value, selectedId: "invented" }),
    "NaN confidence": (value) => ({ ...value, confidence: NaN }),
    "infinite confidence": (value) => ({ ...value, confidence: Infinity }),
    "negative confidence": (value) => ({ ...value, confidence: -1 }),
    "low confidence": (value) => ({ ...value, confidence: 0.6 }),
    "high confidence": (value) => ({ ...value, confidence: 1.01 }),
    "NaN probability": (value) => ({
      ...value,
      probabilities: { ...value.probabilities, handoff: NaN },
    }),
    "infinite probability": (value) => ({
      ...value,
      probabilities: { ...value.probabilities, handoff: Infinity },
    }),
    "negative probability": (value) => ({
      ...value,
      probabilities: { ...value.probabilities, handoff: -0.1 },
    }),
    "missing probability": (value) => ({ ...value, probabilities: {} }),
    "extra probability": (value) => ({
      ...value,
      probabilities: { ...value.probabilities, invented: 0 },
    }),
    "wrong sum": (value) => ({
      ...value,
      probabilities: { ...value.probabilities, handoff: 0.5 },
    }),
    "not argmax": (value) => ({
      ...value,
      probabilities: {
        ...value.probabilities,
        [value.selectedId]: 0.2,
        handoff: 0.8,
      },
    }),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, async (t) => {
      const driver = new FakeDriver();
      const result = await taskSession(
        t,
        driver,
        async (_goal, _state, candidates) => mutate(answer(candidates)),
      ).act(request);
      assert.equal(result.status, "handoff");
      assert.equal(driver.executed.length, 0);
    });
  }
});

void test("chooser attempts cannot rewrite observed state, action targets, or history", async (t) => {
  const driver = new FakeDriver();
  const app = taskSession(
    t,
    driver,
    async (_goal, state, candidates, history) => {
      Reflect.set(state.elements[0]!, "label", "Tampered");
      Reflect.set(candidates[0]!.action!.target, "windowId", 999);
      Reflect.set(history, "0", { outcome: "forged" });
      assert.equal(state.elements[0]!.label, "Save");
      assert.equal(candidates[0]!.action!.target.windowId, 7);
      assert.deepEqual(history, []);
      return answer(candidates, "handoff");
    },
  );
  const result = await app.act(request);
  assert.equal(result.status, "handoff");
  assert.equal(result.observation?.elements[0]?.label, "Save");
  assert.deepEqual(
    result.history.map((entry) => entry.outcome),
    ["handoff"],
  );
});

void test("invalid bounds and wrong-window observations never execute", async (t) => {
  const driver = new FakeDriver([
    observation([], { target: { pid: 42, windowId: 8 } }),
  ]);
  const app = taskSession(t, driver, chooseFirst);
  for (const maxSteps of [0, 9, 1.5, NaN])
    await assert.rejects(app.act({ ...request, maxSteps }), /maxSteps/);
  const result = await app.act(request);
  assert.equal(result.status, "unknown");
  assert.equal(driver.executed.length, 0);
});

void test("general text runs offer insertion without implicit replacement", async (t) => {
  const driver = new FakeDriver();
  await taskSession(t, driver, async (_goal, _state, candidates) => {
    const insertion = candidates.find(
      (candidate) => candidate.action?.kind === "type_text",
    );
    assert.equal(insertion?.action?.kind, "type_text");
    assert.equal(
      candidates.some((candidate) => candidate.action?.kind === "set_value"),
      false,
    );
    return answer(candidates, "handoff");
  }).act({ ...request, text: "Additional text" });
});
