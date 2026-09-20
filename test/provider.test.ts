import assert from "node:assert/strict";
import test from "node:test";
import { TypeSafeClient } from "@compootor/effective-jev";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { z } from "zod";
import { createChooser } from "../src/provider.js";
import type { Observation } from "../src/types.js";

const observation: Observation = {
  target: { pid: 10, windowId: 20 },
  snapshotId: "s1",
  appName: "Fixture",
  windowTitle: "Test",
  complete: true,
  degraded: false,
  elements: [
    {
      index: 1,
      token: "s1:1",
      role: "AXTextField",
      secure: true,
      value: "secret-fixture",
      actions: [],
    },
  ],
};
const candidates = [
  { id: "handoff", description: "Ask the caller" },
  { id: "done", description: "Finished" },
];

function makeClient(fetch: typeof globalThis.fetch) {
  return Effect.runPromise(
    TypeSafeClient.make({ apiKey: "fixture-key" }).pipe(
      Effect.provide(
        FetchHttpClient.layer.pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
        ),
      ),
    ),
  );
}

function choiceResponse(answer: Record<string, unknown>) {
  return Response.json({
    model: "fixture",
    usage: { input_tokens: 1, output_tokens: 1 },
    answers: {
      next_action: {
        type: "choice",
        ...answer,
      },
    },
  });
}

void test("effective-jev sends one bounded Choice and redacts secure values", async () => {
  const requestSchema = z
    .object({
      questions: z.object({
        next_action: z.object({ criteria: z.record(z.string()) }),
      }),
    })
    .passthrough();
  const requests: z.infer<typeof requestSchema>[] = [];
  const client = await makeClient(async (_url, init) => {
    requests.push(requestSchema.parse(await new Response(init?.body).json()));
    return choiceResponse({
      choice: "handoff",
      confidence: 0.9,
      probabilities: { handoff: 0.95, done: 0.05 },
    });
  });
  const result = await createChooser(client)(
    "Do the task",
    observation,
    candidates,
    [],
  );
  assert.equal(result.selectedId, "handoff");
  assert.equal(result.model, "fixture");
  assert.equal(result.confidence, 0.9);
  assert.deepEqual(result.probabilities, { handoff: 0.95, done: 0.05 });
  assert.equal(requests.length, 1);
  assert.ok(requests[0]);
  assert.deepEqual(
    new Set(Object.keys(requests[0].questions.next_action.criteria)),
    new Set(["handoff", "done"]),
  );
  assert.ok(!JSON.stringify(requests).includes("secret-fixture"));
  assert.ok(!JSON.stringify(requests).includes("s1:1"));
});

void test("malformed model choices never escape the provider", async () => {
  for (const answer of [
    {
      choice: "invented",
      confidence: 1,
      probabilities: { handoff: 0.5, done: 0.5 },
    },
    { choice: "done", confidence: 1, probabilities: { done: 1 } },
    { choice: "done", confidence: 1, probabilities: { handoff: 1, done: 1 } },
    { choice: "done", confidence: 2, probabilities: { handoff: 0, done: 1 } },
    {
      choice: "done",
      confidence: 1,
      probabilities: { handoff: 0, done: 1, invented: 0.1 },
    },
  ]) {
    const client = await makeClient(async () => choiceResponse(answer));
    await assert.rejects(
      createChooser(client)("Task", observation, candidates, []),
    );
  }
});

void test("provider errors are not retried", async () => {
  let calls = 0;
  const client = await makeClient(async () => {
    calls += 1;
    return Response.json({ error: "fixture failure" }, { status: 503 });
  });
  await assert.rejects(
    createChooser(client)("Task", observation, candidates, []),
  );
  assert.equal(calls, 1);
});

void test("already-cancelled inference sends no request", async () => {
  let calls = 0;
  const client = await makeClient(async () => {
    calls += 1;
    return choiceResponse({
      choice: "done",
      confidence: 1,
      probabilities: { handoff: 0, done: 1 },
    });
  });
  await assert.rejects(
    createChooser(client)(
      "Task",
      observation,
      candidates,
      [],
      AbortSignal.abort(),
    ),
  );
  assert.equal(calls, 0);
});

void test("cancellation during lazy client initialization sends no request", async () => {
  const previousKey = process.env.TYPESAFE_API_KEY;
  const previousFetch = globalThis.fetch;
  let calls = 0;
  process.env.TYPESAFE_API_KEY = "fixture-key";
  globalThis.fetch = async () => {
    calls += 1;
    return choiceResponse({
      choice: "done",
      confidence: 1,
      probabilities: { handoff: 0, done: 1 },
    });
  };
  try {
    const controller = new AbortController();
    const pending = createChooser()(
      "Task",
      observation,
      candidates,
      [],
      controller.signal,
    );
    queueMicrotask(() => controller.abort());
    await assert.rejects(pending);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
  }
});

void test(
  "cancelling active inference aborts HTTP without a retry",
  { timeout: 2_000 },
  async () => {
    let calls = 0;
    let aborts = 0;
    let started = () => {};
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const client = await makeClient(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          calls += 1;
          const signal = init?.signal;
          assert.ok(signal);
          signal.addEventListener(
            "abort",
            () => {
              aborts += 1;
              reject(new Error("Fixture request cancelled"));
            },
            { once: true },
          );
          started();
        }),
    );
    const controller = new AbortController();
    const pending = createChooser(client)(
      "Task",
      observation,
      candidates,
      [],
      controller.signal,
    );
    await requestStarted;
    controller.abort();
    await assert.rejects(pending);
    assert.equal(calls, 1);
    assert.equal(aborts, 1);
  },
);
