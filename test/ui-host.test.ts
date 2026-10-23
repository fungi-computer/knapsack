import * as Scheduler from "effect/Scheduler";
import type { MuleTool, ToolCall } from "@fungi.computer/mule/effect";
import {
  Mycelium,
  type MyceliumJsonValue,
  type SandboxRequest as MyceliumSandboxRequest,
  type SandboxValue,
} from "@fungi.computer/mycelium";
import {
  EventSource as MaintainedEventSource,
  type EventSourceFetchInit,
} from "eventsource";
import {
  createWhistle,
  WhistleActionError,
  type WhistleCommand,
  type WhistleExecutionInput,
  type WhistleRuntime,
} from "@fungi.computer/whistle";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  UiBrowserError,
  handleBrowserRequest,
  runBrowserConnection,
} from "../src/ui/browser.js";
import {
  type UiHost,
  UiHostError,
  type UiHostConnection,
  make,
} from "../src/ui/effect.js";
import { createUiHost } from "../src/ui/host.js";
import {
  uiWireIds,
  BrowserCommandRowSchema,
  type BrowserCommandRow,
  type BrowserClaimResult,
  type BrowserRequest,
  type BrowserWireResult,
} from "../src/ui/wire.js";

function call(code: string): ToolCall {
  return {
    type: "toolCall",
    id: "knapsack-ui-test-call",
    name: "execute",
    arguments: { code },
  };
}

async function invoke(
  tool: MuleTool,
  code: string,
): Promise<MyceliumJsonValue> {
  const prepared = await Effect.runPromise(tool.prepare(call(code)));
  const parts = await Effect.runPromise(
    Stream.runCollect(prepared.execute()).pipe(),
  );
  const text = parts[0]?.result.content[0];
  if (text?.type !== "text")
    throw new Error("Mycelium execute returned no text result");
  return z.json().parse(JSON.parse(text.text));
}

function requestThroughBrowser(
  host: UiHost,
  connection: UiHostConnection,
  whistle: Pick<WhistleRuntime, "snapshot" | "execute">,
  request: BrowserRequest,
): Effect.Effect<BrowserWireResult, UiHostError | UiBrowserError> {
  return Effect.gen(function* () {
    const pending = yield* Effect.forkChild(host.request(request));
    const envelope = yield* connection.take;
    const claimId = expectClaimed(
      yield* claimFor(host, connection, envelope.requestId),
    );
    const result = yield* handleBrowserRequest(
      { baseUrl: "https://fixture.invalid", whistle },
      envelope,
    );
    yield* host.acceptResult({ ...result, claimId });
    return yield* Fiber.join(pending);
  });
}

function serveBrowser(
  host: UiHost,
  connection: UiHostConnection,
  whistle: Pick<WhistleRuntime, "snapshot" | "execute">,
): Effect.Effect<never, UiHostError | UiBrowserError> {
  return Effect.forever(
    connection.take.pipe(
      Effect.flatMap((envelope) =>
        host
          .claim({
            attemptId: uiWireIds.attempt.generate(),
            connectionId: connection.id,
            requestId: envelope.requestId,
          })
          .pipe(
            Effect.flatMap((claim) =>
              claim.status !== "claimed"
                ? Effect.void
                : handleBrowserRequest(
                    { baseUrl: "https://fixture.invalid", whistle },
                    envelope,
                  ).pipe(
                    Effect.flatMap((result) =>
                      host.acceptResult({ ...result, claimId: claim.claimId }),
                    ),
                    Effect.asVoid,
                  ),
            ),
          ),
      ),
    ),
  );
}

function claimFor(
  host: UiHost,
  connection: UiHostConnection,
  requestId: string,
) {
  return host.claim({
    attemptId: uiWireIds.attempt.generate(),
    connectionId: connection.id,
    requestId,
  });
}

function expectClaimed(claim: BrowserClaimResult): string {
  if (claim.status !== "claimed")
    throw new Error("Fixture request was not claimable");
  return claim.claimId;
}

function failureFrom<A>(exit: Exit.Exit<A, UiHostError>): UiHostError {
  if (Exit.isSuccess(exit))
    throw new Error("Expected Knapsack.ui host failure");
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isNone(failure)) throw new Error("Expected typed failure");
  return failure.value;
}

describe("Knapsack.ui connected browser capability", () => {
  it.each([false, true])(
    "discovers a scoped Whistle command through the browser wire with action: %s",
    async (withAction) => {
      const whistle = createWhistle();
      let executions = 0;
      let command: WhistleCommand<never> = {
        id: "submit",
        title: "Submit form",
        category: "forms",
        projections: { agent: { order: 1 } },
        handler: () => {
          executions += 1;
        },
      };
      let expected: BrowserCommandRow = {
        commandId: "form:submit",
        sourceId: "mounted-app",
        title: "Submit form",
        category: "forms",
        description: null,
        order: 1,
        keybind: null,
        availability: { status: "available" },
      };
      if (withAction) {
        const action = { inputSchema: { type: "object" } };
        command = { ...command, action };
        expected = { ...expected, action };
      }
      whistle.contribute({
        sourceId: "mounted-app",
        namespace: "form",
        scope: "selected-app",
        commands: [command],
      });
      try {
        expect(whistle.snapshot().agent[0]?.scope).toBe("selected-app");
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const host = yield* make();
              const connection = yield* host.connect();
              const discovery = yield* requestThroughBrowser(
                host,
                connection,
                whistle,
                { type: "discover" },
              );
              const execution = yield* requestThroughBrowser(
                host,
                connection,
                whistle,
                { type: "execute", commandId: "form:submit" },
              );
              return { discovery, execution };
            }),
          ),
        );
        expect(result.discovery).toEqual({
          type: "discover",
          commands: [expected],
        });
        expect(result.execution).toEqual({
          type: "execute",
          outcome: { status: "handled" },
        });
        expect(executions).toBe(1);
      } finally {
        whistle.close();
      }
    },
  );

  it("discovers current Whistle rows and executes normalized outcomes", async () => {
    let visible = false;
    let executeCalls = 0;
    const whistle = createWhistle();
    whistle.contribute({
      sourceId: "demo-browser",
      namespace: "demo",
      commands: [
        {
          id: "show",
          title: "Show browser state",
          category: "navigation",
          projections: { agent: { order: 1 } },
          handler: (input) => {
            executeCalls += 1;
            // Whistle supplies a fresh host-owned signal when the caller has none.
            expect(Object.keys(input).sort()).toEqual(["origin", "signal"]);
            expect(input.origin).toBe("agent");
            expect(input.signal).toBeInstanceOf(AbortSignal);
            expect(input.signal?.aborted).toBe(false);
            visible = true;
          },
        },
        {
          id: "fail",
          title: "Fail",
          category: "test",
          handler: () => {
            throw new Error("fixture failed");
          },
        },
        {
          id: "invalid-result",
          title: "Invalid result",
          category: "test",
          handler: () => BigInt(1),
        },
      ],
    });

    const results = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* make();
          const connection = yield* host.connect();
          const discovery = yield* requestThroughBrowser(
            host,
            connection,
            whistle,
            { type: "discover" },
          );
          const handled = yield* requestThroughBrowser(
            host,
            connection,
            whistle,
            { type: "execute", commandId: "demo:show" },
          );
          const missing = yield* requestThroughBrowser(
            host,
            connection,
            whistle,
            { type: "execute", commandId: "demo:missing" },
          );
          const failed = yield* requestThroughBrowser(
            host,
            connection,
            whistle,
            { type: "execute", commandId: "demo:fail" },
          );
          const invalidResult = yield* requestThroughBrowser(
            host,
            connection,
            whistle,
            { type: "execute", commandId: "demo:invalid-result" },
          );
          const invalid = yield* requestThroughBrowser(
            host,
            connection,
            whistle,
            { type: "execute", commandId: "" },
          );
          whistle.close();
          const closed = yield* requestThroughBrowser(
            host,
            connection,
            whistle,
            { type: "execute", commandId: "demo:show" },
          );
          return {
            discovery,
            handled,
            missing,
            failed,
            invalidResult,
            invalid,
            closed,
          };
        }),
      ),
    );

    expect(results.discovery).toEqual({
      type: "discover",
      commands: [
        {
          commandId: "demo:show",
          sourceId: "demo-browser",
          title: "Show browser state",
          category: "navigation",
          description: null,
          order: 1,
          keybind: null,
          availability: { status: "available" },
        },
      ],
    });
    expect(results.handled).toEqual({
      type: "execute",
      outcome: { status: "handled" },
    });
    expect(results.missing).toEqual({
      type: "execute",
      outcome: { status: "missing" },
    });
    expect(results.failed).toEqual({
      type: "execute",
      outcome: {
        status: "failed",
        error: { code: "command_failed", message: "fixture failed" },
      },
    });
    expect(results.invalidResult).toEqual({
      type: "execute",
      outcome: {
        status: "failed",
        error: {
          code: "invalid_command_result",
          message: "Command result is not valid JSON data",
        },
      },
    });
    expect(results.invalid).toEqual({
      type: "execute",
      outcome: { status: "invalid" },
    });
    expect(results.closed).toEqual({
      type: "execute",
      outcome: { status: "closed" },
    });
    expect(visible).toBe(true);
    expect(executeCalls).toBe(1);
  });

  it("skips cancelled dispatch and makes late settlement nonfatal", async () => {
    const host = Effect.runSync(make());
    const offline = await Effect.runPromiseExit(
      host.request({ type: "discover" }),
    );
    expect(failureFrom(offline).code).toBe("browser_not_connected");

    const malformed = await Effect.runPromiseExit(
      host.acceptResult({ requestId: "not-cairn", result: {} }),
    );
    expect(failureFrom(malformed).code).toBe("invalid_browser_wire");

    let executeCalls = 0;
    const whistle = createWhistle();
    whistle.contribute({
      sourceId: "disconnect-browser",
      namespace: "demo",
      commands: [
        {
          id: "show",
          title: "Show",
          category: "test",
          handler: () => {
            executeCalls += 1;
          },
        },
      ],
    });

    const indeterminate = await Effect.runPromise(
      Effect.gen(function* () {
        const connectionScope = yield* Scope.make();
        const connection = yield* host
          .connect()
          .pipe(Scope.provide(connectionScope));
        const pending = yield* Effect.forkChild(
          host.request({ type: "execute", commandId: "demo:show" }),
        );
        const envelope = yield* connection.take;
        const claimId = expectClaimed(
          yield* claimFor(host, connection, envelope.requestId),
        );
        const result = yield* handleBrowserRequest(
          { baseUrl: "https://fixture.invalid", whistle },
          envelope,
        );
        yield* Scope.close(connectionScope, Exit.void);
        const requestExit = yield* Fiber.await(pending);
        const late = yield* host.acceptResult({
          ...result,
          claimId,
        });
        const duplicate = yield* host.acceptResult({
          ...result,
          claimId,
        });
        return { requestExit, late, duplicate };
      }),
    );
    expect(failureFrom(indeterminate.requestExit).code).toBe(
      "browser_execution_indeterminate",
    );
    expect(indeterminate.late).toEqual({ status: "ignored" });
    expect(indeterminate.duplicate).toEqual({ status: "ignored" });
    expect(executeCalls).toBe(1);

    const skipped = await Effect.runPromise(
      Effect.gen(function* () {
        const connectionScope = yield* Scope.make();
        const connection = yield* host
          .connect()
          .pipe(Scope.provide(connectionScope));
        const pending = yield* Effect.forkChild(
          host.request({ type: "execute", commandId: "demo:show" }),
        );
        const envelope = yield* connection.take;
        yield* Fiber.interrupt(pending);
        const claim = yield* claimFor(host, connection, envelope.requestId);
        yield* Scope.close(connectionScope, Exit.void);
        return claim;
      }),
    );
    expect(skipped).toEqual({ status: "skipped" });
    expect(executeCalls).toBe(1);

    const retryableDiscovery = await Effect.runPromise(
      Effect.gen(function* () {
        const connectionScope = yield* Scope.make();
        const connection = yield* host
          .connect()
          .pipe(Scope.provide(connectionScope));
        const pending = yield* Effect.forkChild(
          host.request({ type: "discover" }),
        );
        yield* connection.take;
        yield* Scope.close(connectionScope, Exit.void);
        return yield* Fiber.await(pending);
      }),
    );
    expect(failureFrom(retryableDiscovery).code).toBe("browser_disconnected");
  });

  it("owns one outstanding request through cancellation and settlement", async () => {
    const handlerStarted = Effect.runSync(Deferred.make<undefined>());
    const releaseHandler = Effect.runSync(Deferred.make<undefined>());
    const whistle = createWhistle();
    whistle.contribute({
      sourceId: "held-browser",
      namespace: "demo",
      commands: [
        {
          id: "hold",
          title: "Hold",
          category: "test",
          handler: () =>
            Effect.runPromise(
              Deferred.succeed(handlerStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseHandler)),
              ),
            ),
        },
      ],
    });

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* make();
          const connection = yield* host.connect();
          const requester = yield* Effect.forkChild(
            host.request({ type: "execute", commandId: "demo:hold" }),
          );
          const envelope = yield* connection.take;
          const claimId = expectClaimed(
            yield* claimFor(host, connection, envelope.requestId),
          );
          const execution = yield* Effect.forkChild(
            handleBrowserRequest(
              { baseUrl: "https://fixture.invalid", whistle },
              envelope,
            ),
          );
          yield* Deferred.await(handlerStarted);

          const concurrent = yield* Effect.all(
            [
              Effect.exit(host.request({ type: "discover" })),
              Effect.exit(host.request({ type: "discover" })),
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.timeout("250 millis"));

          yield* Fiber.interrupt(requester);
          const afterCancellation = yield* Effect.exit(
            host.request({ type: "discover" }),
          ).pipe(Effect.timeout("250 millis"));

          yield* Deferred.succeed(releaseHandler, undefined);
          const result = yield* Fiber.join(execution);
          const settlement = yield* host.acceptResult({
            ...result,
            claimId,
          });
          const duplicate = yield* host.acceptResult({
            requestId: envelope.requestId,
            claimId,
            result: {
              type: "execute",
              outcome: { status: "handled" },
            },
          });
          const reused = yield* requestThroughBrowser(
            host,
            connection,
            whistle,
            { type: "discover" },
          );

          return {
            afterCancellation,
            concurrent,
            duplicate,
            reused,
            settlement,
          };
        }).pipe(Effect.timeout("2 seconds")),
      ),
    );

    expect(
      result.concurrent.map(failureFrom).map((error) => error.code),
    ).toEqual(["browser_busy", "browser_busy"]);
    expect(failureFrom(result.afterCancellation).code).toBe("browser_busy");
    expect(result.settlement).toEqual({ status: "accepted" });
    expect(result.duplicate).toEqual({ status: "ignored" });
    expect(result.reused).toEqual({
      type: "discover",
      commands: [],
    });
  });

  it("marks ownership when interrupted as admission returns", async () => {
    const claim = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* make();
          const connection = yield* host.connect();
          const requester = yield* Effect.forkChild(
            host
              .request({ type: "discover" })
              .pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 10)),
          );
          const envelope = yield* connection.take;
          yield* Fiber.interrupt(requester);
          return yield* claimFor(host, connection, envelope.requestId);
        }).pipe(Effect.timeout("1 second")),
      ),
    );

    expect(claim).toEqual({ status: "skipped" });
  });

  it("reoffers a request after an unfinished browser claim lease expires", async () => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* make({ claimLeaseMs: 100 });
          const lostTab = yield* host.connect();
          const liveTab = yield* host.connect();
          const pending = yield* Effect.forkChild(
            host.request({ type: "discover" }),
          );
          const lostDelivery = yield* lostTab.take;
          const liveDelivery = yield* liveTab.take;
          const lostAttemptId = uiWireIds.attempt.generate();
          const liveAttemptId = uiWireIds.attempt.generate();
          const lostClaim = yield* host.claim({
            attemptId: lostAttemptId,
            connectionId: lostTab.id,
            requestId: lostDelivery.requestId,
          });
          const repeatedClaim = yield* host.claim({
            attemptId: lostAttemptId,
            connectionId: lostTab.id,
            requestId: lostDelivery.requestId,
          });
          const waiting = yield* host.claim({
            attemptId: liveAttemptId,
            connectionId: liveTab.id,
            requestId: liveDelivery.requestId,
          });
          yield* Effect.sleep("125 millis");
          const expiredSettlement = yield* host.acceptResult({
            requestId: lostDelivery.requestId,
            claimId: lostClaim.status === "claimed" ? lostClaim.claimId : "",
            result: { type: "discover", commands: [] },
          });
          const replacementClaim = yield* host.claim({
            attemptId: liveAttemptId,
            connectionId: liveTab.id,
            requestId: liveDelivery.requestId,
          });
          if (lostClaim.status !== "claimed")
            throw new Error("First browser tab did not claim the request");
          if (replacementClaim.status !== "claimed")
            throw new Error("The expired claim was not reoffered");
          const stale = yield* host.acceptResult({
            requestId: lostDelivery.requestId,
            claimId: lostClaim.claimId,
            result: { type: "discover", commands: [] },
          });
          const accepted = yield* host.acceptResult({
            requestId: liveDelivery.requestId,
            claimId: replacementClaim.claimId,
            result: { type: "discover", commands: [] },
          });
          const result = yield* Fiber.join(pending);
          return {
            accepted,
            expiredSettlement,
            lostClaim,
            repeatedClaim,
            replacementClaim,
            result,
            stale,
            waiting,
          };
        }).pipe(Effect.timeout("1 second")),
      ),
    );

    expect(outcome.lostClaim.status).toBe("claimed");
    expect(outcome.repeatedClaim).toEqual(outcome.lostClaim);
    expect(outcome.expiredSettlement).toEqual({ status: "ignored" });
    expect(outcome.waiting.status).toBe("waiting");
    if (outcome.waiting.status !== "waiting")
      throw new Error("The competing tab did not wait for the first lease");
    expect(outcome.waiting.retryAfterMs).toBeGreaterThan(0);
    expect(outcome.replacementClaim.status).toBe("claimed");
    expect(outcome.replacementClaim).not.toEqual(outcome.lostClaim);
    expect(outcome.stale).toEqual({ status: "ignored" });
    expect(outcome.accepted).toEqual({ status: "accepted" });
    expect(outcome.result).toEqual({
      type: "discover",
      commands: [],
    });
  });

  it("reoffers an unfinished claim when its browser tab disconnects", async () => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* make();
          const lostScope = yield* Scope.make();
          const lostTab = yield* host.connect().pipe(Scope.provide(lostScope));
          const liveTab = yield* host.connect();
          const pending = yield* Effect.forkChild(
            host.request({ type: "discover" }),
          );
          const lostDelivery = yield* lostTab.take;
          yield* liveTab.take;
          const lostClaim = expectClaimed(
            yield* claimFor(host, lostTab, lostDelivery.requestId),
          );

          yield* Scope.close(lostScope, Exit.void);
          const claimAfterDisconnect = yield* claimFor(
            host,
            lostTab,
            lostDelivery.requestId,
          );
          const reofferedDelivery = yield* liveTab.take;
          const replacementClaim = expectClaimed(
            yield* claimFor(host, liveTab, reofferedDelivery.requestId),
          );
          const stale = yield* host.acceptResult({
            requestId: lostDelivery.requestId,
            claimId: lostClaim,
            result: { type: "discover", commands: [] },
          });
          const accepted = yield* host.acceptResult({
            requestId: reofferedDelivery.requestId,
            claimId: replacementClaim,
            result: { type: "discover", commands: [] },
          });
          return {
            accepted,
            claimAfterDisconnect,
            lostClaim,
            replacementClaim,
            result: yield* Fiber.join(pending),
            stale,
          };
        }).pipe(Effect.timeout("1 second")),
      ),
    );

    expect(outcome.replacementClaim).not.toBe(outcome.lostClaim);
    expect(outcome.claimAfterDisconnect).toEqual({ status: "skipped" });
    expect(outcome.stale).toEqual({ status: "ignored" });
    expect(outcome.accepted).toEqual({ status: "accepted" });
    expect(outcome.result).toEqual({ type: "discover", commands: [] });
  });

  it("cannot orphan a requester when result settlement is interrupted", async () => {
    const settled = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* make();
          const connection = yield* host.connect();
          const pending = yield* Effect.forkChild(
            host.request({ type: "discover" }),
          );
          const envelope = yield* connection.take;
          const claimId = expectClaimed(
            yield* claimFor(host, connection, envelope.requestId),
          );
          const result = {
            requestId: envelope.requestId,
            claimId,
            result: { type: "discover", commands: [] },
          } as const;
          const settlement = yield* Effect.forkChild(
            host
              .acceptResult(result)
              .pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 10)),
          );
          yield* Fiber.interrupt(settlement);
          const duplicate = yield* host.acceptResult(result);
          const requester = yield* Fiber.join(pending);
          return { duplicate, requester };
        }).pipe(Effect.timeout("1 second")),
      ),
    );

    expect(["accepted", "ignored"]).toContain(settled.duplicate.status);
    expect(settled.requester).toEqual({ type: "discover", commands: [] });
  });

  it("crosses Mycelium and the Effect browser fixture to real Whistle", async () => {
    let visible = false;
    const whistle = createWhistle();
    whistle.contribute({
      sourceId: "mycelium-browser",
      namespace: "demo",
      commands: [
        {
          id: "show",
          title: "Show",
          category: "demo",
          projections: { agent: { order: 1 } },
          handler: () => {
            visible = true;
          },
        },
      ],
    });
    const effectHost = Effect.runSync(make());
    const agentHost = createUiHost(effectHost);
    const connectionScope = await Effect.runPromise(Scope.make());
    const connection = await Effect.runPromise(
      effectHost.connect().pipe(Scope.provide(connectionScope)),
    );
    const browser = Effect.runFork(
      serveBrowser(effectHost, connection, whistle),
    );
    const runtime = await Mycelium.make({
      modules: agentHost.modules,
      sandbox: {
        execute: async (
          request: MyceliumSandboxRequest,
        ): Promise<SandboxValue> => {
          const ui = request.bindings.ui;
          if (ui === undefined) throw new Error("Missing ui capability");
          if (request.code === "discover") {
            const discover = ui.discover;
            if (discover === undefined) throw new Error("Missing ui.discover");
            return await discover({});
          }
          const execute = ui.execute;
          if (execute === undefined) throw new Error("Missing ui.execute");
          return await execute({ commandId: "demo:show" });
        },
      },
    });
    const lease = await runtime.acquire();

    try {
      await expect(invoke(lease.executeTool, "discover")).resolves.toEqual({
        status: "available",
        commands: [
          {
            commandId: "demo:show",
            sourceId: "mycelium-browser",
            title: "Show",
            category: "demo",
            description: null,
            order: 1,
            keybind: null,
            availability: { status: "available" },
          },
        ],
      });
      await expect(invoke(lease.executeTool, "execute")).resolves.toEqual({
        status: "handled",
      });
      expect(visible).toBe(true);
    } finally {
      await lease.release();
      await runtime.close();
      await Effect.runPromise(Fiber.interrupt(browser));
      await Effect.runPromise(Scope.close(connectionScope, Exit.void));
    }
  });

  it.each([false, true])("wire roundtrip, injected=%s", async (injected) => {
    let availability:
      { status: "available" } | { status: "unavailable"; reason: string } = {
      status: "available",
    };
    const calls: unknown[] = [];
    const inputSchema = {
      type: "object",
      properties: {
        target: {
          type: "string",
          enum: ["alpha", "bad"],
          title: "Target",
        },
      },
      required: ["target"],
      "x-knapsack-ui": "preserve-me",
    };
    const outputSchema = {
      type: "object",
      properties: { accepted: { type: "string" } },
      "x-result-label": "Receipt",
    };
    const row = {
      commandId: "wire:dispatch",
      sourceId: "wire-browser",
      title: "Dispatch",
      category: "agent",
      description: null,
      order: 1,
      keybind: null,
      availability: { status: "available" },
    };
    expect(() =>
      BrowserCommandRowSchema.parse({
        ...row,
        action: { inputSchema: [] },
      }),
    ).toThrow();
    expect(() =>
      BrowserCommandRowSchema.parse({
        ...row,
        action: {
          inputSchema,
          outputSchema: 42,
        },
      }),
    ).toThrow();
    expect(() =>
      BrowserCommandRowSchema.parse({
        ...row,
        action: {
          inputSchema: [],
          outputSchema,
        },
      }),
    ).toThrow();
    const whistle = createWhistle();
    whistle.contribute({
      sourceId: "wire-browser",
      namespace: "wire",
      commands: [
        {
          id: "dispatch",
          title: "Dispatch",
          category: "agent",
          projections: { agent: { order: 1 } },
          action: {
            inputSchema,
            outputSchema,
            presentation: { type: "choice", options: [] },
          },
          availability: () => availability,
          handler: ({
            arguments: input,
          }: WhistleExecutionInput<{ target: string }>) => {
            calls.push(input);
            const target = input?.target;
            if (target === "bad")
              throw new WhistleActionError(
                "target_rejected",
                "Target was rejected",
                { target, "x-reason": "fixture" },
              );
            return { accepted: target };
          },
        },
        {
          id: "presentation-only",
          title: "Presentation only",
          category: "agent",
          projections: { agent: { order: 2 } },
          action: { presentation: { type: "choice", options: [] } },
          handler: () => undefined,
        },
      ],
    });

    const effectHost = Effect.runSync(make());
    const agentHost = createUiHost(effectHost);
    const routes = new Set<string>();
    const admittedFetch: typeof globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      const headers = new Headers(request.headers);
      headers.set("X-Oyster-Installation", "stage");
      const admitted = new Request(request, { headers });
      // This is the host's installation-authorized Fetch port. The bridge
      // must use it for claims/results as well as the maintained SSE client.
      routes.add(`${admitted.method} ${new URL(admitted.url).pathname}`);
      return agentHost.fetch(admitted);
    };
    let eventSourceOpen = false;
    class EventSourceFixture extends MaintainedEventSource {
      public constructor(url: string) {
        super(url, {
          fetch: (input: string | URL, init: EventSourceFetchInit) =>
            admittedFetch(input, init),
        });
        this.addEventListener("open", () => {
          eventSourceOpen = true;
        });
      }
    }

    const transport = {
      fetch: admittedFetch,
      openEvents: (url: string) => new EventSourceFixture(url),
    };
    if (injected) {
      vi.stubGlobal(
        "EventSource",
        class extends EventTarget {
          constructor() {
            super();
            throw new Error(
              "The authorized connection used ambient EventSource",
            );
          }
        },
      );
      vi.stubGlobal("fetch", () =>
        Promise.reject(
          new Error("The authorized connection used ambient Fetch"),
        ),
      );
    } else {
      vi.stubGlobal("EventSource", EventSourceFixture);
      vi.stubGlobal("fetch", admittedFetch);
    }
    const baseOptions = { baseUrl: "https://fixture.invalid", whistle };
    const options = injected ? { ...baseOptions, transport } : baseOptions;
    const browser = Effect.runFork(
      Effect.scoped(runBrowserConnection(options)),
    );
    const runtime = await Mycelium.make({
      modules: agentHost.modules,
      sandbox: {
        execute: async (
          request: MyceliumSandboxRequest,
        ): Promise<SandboxValue> => {
          const ui = request.bindings.ui;
          if (ui === undefined) throw new Error("Missing ui capability");
          if (request.code === "discover") {
            const discover = ui.discover;
            if (discover === undefined) throw new Error("Missing discovery");
            return await discover({});
          }
          const execute = ui.execute;
          if (execute === undefined) throw new Error("Missing execution");
          return await execute({
            commandId: "wire:dispatch",
            arguments: { target: request.code === "fail" ? "bad" : "alpha" },
          });
        },
      },
    });
    const lease = await runtime.acquire();

    try {
      await vi.waitFor(() => {
        expect(eventSourceOpen).toBe(true);
      });
      await expect(invoke(lease.executeTool, "discover")).resolves.toEqual({
        status: "available",
        commands: [
          {
            commandId: "wire:dispatch",
            sourceId: "wire-browser",
            title: "Dispatch",
            category: "agent",
            description: null,
            order: 1,
            keybind: null,
            availability: { status: "available" },
            action: { inputSchema, outputSchema },
          },
          {
            commandId: "wire:presentation-only",
            sourceId: "wire-browser",
            title: "Presentation only",
            category: "agent",
            description: null,
            order: 2,
            keybind: null,
            availability: { status: "available" },
          },
        ],
      });
      await expect(invoke(lease.executeTool, "alpha")).resolves.toEqual({
        status: "handled",
        result: { accepted: "alpha" },
      });
      await expect(invoke(lease.executeTool, "fail")).resolves.toEqual({
        status: "failed",
        error: {
          code: "target_rejected",
          message: "Target was rejected",
          details: { target: "bad", "x-reason": "fixture" },
        },
      });
      availability = {
        status: "unavailable",
        reason: "Team directory changed",
      };
      await expect(invoke(lease.executeTool, "discover")).resolves.toEqual({
        status: "available",
        commands: [
          {
            commandId: "wire:dispatch",
            sourceId: "wire-browser",
            title: "Dispatch",
            category: "agent",
            description: null,
            order: 1,
            keybind: null,
            availability: {
              status: "unavailable",
              reason: "Team directory changed",
            },
            action: { inputSchema, outputSchema },
          },
          {
            commandId: "wire:presentation-only",
            sourceId: "wire-browser",
            title: "Presentation only",
            category: "agent",
            description: null,
            order: 2,
            keybind: null,
            availability: { status: "available" },
          },
        ],
      });
      await expect(invoke(lease.executeTool, "alpha")).resolves.toEqual({
        status: "unavailable",
        reason: "Team directory changed",
      });
      expect(calls).toEqual([{ target: "alpha" }, { target: "bad" }]);
      expect([...routes].sort()).toEqual([
        "GET /browser/events",
        "POST /browser/claims",
        "POST /browser/results",
      ]);
    } finally {
      await lease.release();
      await runtime.close();
      await Effect.runPromise(Fiber.interrupt(browser));
      vi.unstubAllGlobals();
    }
  });

  it("reports no connected browser through the Mycelium operation edge", async () => {
    const agentHost = createUiHost();
    const runtime = await Mycelium.make({
      modules: agentHost.modules,
      sandbox: {
        execute: async (
          request: MyceliumSandboxRequest,
        ): Promise<SandboxValue> => {
          const ui = request.bindings.ui;
          if (ui === undefined) throw new Error("Missing ui capability");
          if (request.code === "discover") {
            const discover = ui.discover;
            if (discover === undefined) throw new Error("Missing ui.discover");
            return await discover({});
          }
          const execute = ui.execute;
          if (execute === undefined) throw new Error("Missing ui.execute");
          return await execute({ commandId: "demo:show" });
        },
      },
    });
    const lease = await runtime.acquire();

    try {
      await expect(
        invoke(lease.executeTool, "return ui.discover({})"),
      ).resolves.toEqual({
        status: "unavailable",
        reason: "browser_not_connected",
      });
      await expect(invoke(lease.executeTool, "execute")).resolves.toEqual({
        status: "unavailable",
        reason: "browser_not_connected",
      });
    } finally {
      await lease.release();
      await runtime.close();
    }
  });

  it("keeps claim and result HTTP ingress schema-owned", async () => {
    const agentHost = createUiHost();

    for (const [path, message] of [
      ["claims", "Browser claim is invalid"],
      ["results", "Browser result is invalid"],
    ] as const) {
      const response = await agentHost.fetch(
        new Request(`https://fixture.invalid/browser/${path}`, {
          method: "POST",
          body: "{",
        }),
      );
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: message });
    }
  });

  it("delivers string browser data and rejects invalid event representations", async () => {
    let listener: ((event: Event) => void) | undefined;
    let closes = 0;
    class EventSourceFixture {
      close(): void {
        closes += 1;
      }
      addEventListener(_name: string, next: (event: Event) => void): void {
        listener = next;
      }
      removeEventListener(): void {
        listener = undefined;
      }
    }
    function emit(event: Event): void {
      if (listener === undefined)
        throw new Error("Event listener is unavailable");
      listener(event);
    }
    const effectHost = Effect.runSync(make());
    const agentHost = createUiHost(effectHost);
    const connectionScope = await Effect.runPromise(Scope.make());
    const connection = await Effect.runPromise(
      effectHost.connect().pipe(Scope.provide(connectionScope)),
    );
    const pending = Effect.runFork(effectHost.request({ type: "discover" }));
    const envelope = await Effect.runPromise(connection.take);
    const fetch = vi.fn((input: string, init?: RequestInit) =>
      agentHost.fetch(new Request(input, init)),
    );
    vi.stubGlobal("EventSource", EventSourceFixture);
    vi.stubGlobal("fetch", fetch);

    try {
      const browser = Effect.runFork(
        Effect.scoped(
          runBrowserConnection({
            baseUrl: "https://fixture.invalid",
            whistle: createWhistle(),
          }),
        ),
      );
      await vi.waitFor(() => {
        expect(listener).toBeDefined();
      });
      emit(
        new MessageEvent("browser-request", {
          data: JSON.stringify({ ...envelope, connectionId: connection.id }),
        }),
      );
      await expect(Effect.runPromise(Fiber.join(pending))).resolves.toEqual({
        type: "discover",
        commands: [],
      });
      expect(fetch.mock.calls[0]?.[0]).toBe(
        "https://fixture.invalid/browser/claims",
      );
      expect(fetch.mock.calls[1]?.[0]).toBe(
        "https://fixture.invalid/browser/results",
      );
      const claimBody = z.string().parse(fetch.mock.calls[0]?.[1]?.body);
      expect(JSON.parse(claimBody)).toMatchObject({
        connectionId: connection.id,
        requestId: envelope.requestId,
      });
      const resultBody = z.string().parse(fetch.mock.calls[1]?.[1]?.body);
      const resultPayload = z
        .looseObject({
          claimId: z.string(),
          requestId: z.string(),
          result: z.looseObject({
            type: z.literal("discover"),
            commands: z.array(z.unknown()),
          }),
        })
        .parse(JSON.parse(resultBody));
      expect(resultPayload.requestId).toBe(envelope.requestId);
      expect(resultPayload.result).toEqual({
        type: "discover",
        commands: [],
      });
      expect(resultPayload.claimId.length).toBeGreaterThan(0);
      await Effect.runPromise(Fiber.interrupt(browser));
      expect(closes).toBe(1);

      const fetchesBeforeInvalidEvents = fetch.mock.calls.length;
      for (const event of [
        new MessageEvent("browser-request", { data: "{" }),
        new MessageEvent("browser-request", { data: {} }),
        new Event("browser-request"),
      ]) {
        listener = undefined;
        const browser = Effect.runFork(
          Effect.scoped(
            runBrowserConnection({
              baseUrl: "https://fixture.invalid",
              whistle: createWhistle(),
            }),
          ),
        );
        await vi.waitFor(() => {
          expect(listener).toBeDefined();
        });
        emit(event);
        const exit = await Effect.runPromise(Fiber.await(browser));
        if (Exit.isSuccess(exit))
          throw new Error("Expected browser data failure");
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure) && failure.value).toMatchObject({
          name: "UiBrowserError",
          message: "Browser request payload is invalid",
        });
      }
      expect(fetch).toHaveBeenCalledTimes(fetchesBeforeInvalidEvents);
    } finally {
      vi.unstubAllGlobals();
      await Effect.runPromise(Scope.close(connectionScope, Exit.void));
    }
  });
});
