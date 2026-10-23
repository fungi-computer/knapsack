import { Mycelium, type ModuleRegistration } from "@fungi.computer/mycelium";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { z } from "zod";

import {
  type UiHost as EffectUiHost,
  UiHostError,
  make as makeEffect,
} from "./effect.js";

import {
  BrowserCommandRowSchema,
  BrowserExecutionOutcomeSchema,
  BrowserExecuteInputSchema,
  BrowserWireObjectSchema,
  type BrowserRequest,
  type BrowserWireResult,
} from "./wire.js";

const browserUnavailableSchema = z.object({
  status: z.literal("unavailable"),
  reason: z.enum([
    "browser_busy",
    "browser_not_connected",
    "browser_disconnected",
  ]),
});

const browserExecutionIndeterminateSchema = z.object({
  status: z.literal("indeterminate"),
  reason: z.literal("browser_disconnected_after_dispatch"),
});

const browserCommandDiscoverySchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    commands: z.array(BrowserCommandRowSchema),
  }),
  browserUnavailableSchema,
]);

const browserCommandExecutionSchema = z.union([
  BrowserExecutionOutcomeSchema,
  browserUnavailableSchema,
  browserExecutionIndeterminateSchema,
]);

/** Mycelium JSON result for live command discovery. */
type BrowserCommandDiscovery = z.output<typeof browserCommandDiscoverySchema>;

/** Mycelium JSON result for one normalized Whistle execution. */
type BrowserCommandExecution = z.output<typeof browserCommandExecutionSchema>;

type BrowserUnavailable = z.output<typeof browserUnavailableSchema>;
type BrowserExecutionIndeterminate = z.output<
  typeof browserExecutionIndeterminateSchema
>;

/** Promise/HTTP facade over one Session's Effect-owned browser host. */
export type UiHostFacade = Readonly<{
  modules: readonly [ModuleRegistration];
  fetch: (request: Request) => Promise<Response>;
}>;

async function runPromiseAtBoundary<A, E extends Error>(
  effect: Effect.Effect<A, E>,
  signal?: AbortSignal,
): Promise<A> {
  signal?.throwIfAborted();
  const exit = await Effect.runPromiseExit(
    effect,
    signal === undefined ? undefined : { signal },
  );
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure)) throw failure.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    signal?.throwIfAborted();
    throw new DOMException("The operation was aborted", "AbortError");
  }
  const squashed = Cause.squash(exit.cause);
  if (squashed instanceof Error) throw squashed;
  throw new Error("Live App command host failed without an Error cause");
}

function unavailable(reason: BrowserUnavailable["reason"]): BrowserUnavailable {
  return { status: "unavailable", reason };
}

function recoverUnavailable(
  error: UiHostError,
): Effect.Effect<BrowserUnavailable, UiHostError> {
  switch (error.code) {
    case "browser_busy":
    case "browser_not_connected":
    case "browser_disconnected":
      return Effect.succeed(unavailable(error.code));
    default:
      return Effect.fail(error);
  }
}

function discoveryRequest(
  runtime: EffectUiHost,
  request: Extract<BrowserRequest, { readonly type: "discover" }>,
): Effect.Effect<BrowserWireResult | BrowserUnavailable, UiHostError> {
  return runtime.request(request).pipe(Effect.catch(recoverUnavailable));
}

function executionRequest(
  runtime: EffectUiHost,
  request: Extract<BrowserRequest, { readonly type: "execute" }>,
): Effect.Effect<
  BrowserWireResult | BrowserUnavailable | BrowserExecutionIndeterminate,
  UiHostError
> {
  return runtime.request(request).pipe(
    Effect.catch(
      (
        error,
      ): Effect.Effect<
        BrowserUnavailable | BrowserExecutionIndeterminate,
        UiHostError
      > => {
        if (error.code === "browser_execution_indeterminate")
          return Effect.succeed<BrowserExecutionIndeterminate>({
            status: "indeterminate",
            reason: "browser_disconnected_after_dispatch",
          });
        return recoverUnavailable(error);
      },
    ),
  );
}

function discoveryResult(
  result: BrowserWireResult | BrowserUnavailable,
): BrowserCommandDiscovery {
  if ("status" in result) return result;
  if (result.type !== "discover")
    throw new UiHostError(
      "invalid_browser_wire",
      "Browser returned an execution result for discovery",
    );
  return { status: "available", commands: [...result.commands] };
}

function executionResult(
  result:
    BrowserWireResult | BrowserUnavailable | BrowserExecutionIndeterminate,
): BrowserCommandExecution {
  if ("status" in result) return result;
  if (result.type !== "execute")
    throw new UiHostError(
      "invalid_browser_wire",
      "Browser returned a discovery result for execution",
    );
  return result.outcome;
}

function eventResponse(runtime: EffectUiHost): Response {
  const body = Stream.unwrap(
    runtime.connect().pipe(
      Effect.map((connection) =>
        Stream.make(": connected\n\n").pipe(
          Stream.concat(
            Stream.fromEffectRepeat(connection.take).pipe(
              Stream.map(
                (envelope) =>
                  `event: browser-request\ndata: ${JSON.stringify({
                    ...envelope,
                    connectionId: connection.id,
                  })}\n\n`,
              ),
            ),
          ),
        ),
      ),
    ),
  ).pipe(Stream.encodeText, (stream) =>
    Stream.toReadableStream(stream, {
      strategy: { highWaterMark: 1 },
    }),
  );
  return new Response(body, {
    headers: {
      "Cache-Control": "no-cache",
      "Content-Encoding": "Identity",
      "Content-Type": "text/event-stream",
    },
  });
}

function errorResponse(cause: unknown): Response {
  if (!(cause instanceof UiHostError))
    return Response.json(
      { error: "Live App commands are unavailable" },
      { status: 503 },
    );
  const status = cause.code === "invalid_browser_wire" ? 400 : 503;
  return Response.json({ error: cause.message }, { status });
}

type BrowserIngress<A> = (
  input: Parameters<EffectUiHost["claim"]>[0],
) => Effect.Effect<A, UiHostError>;

async function browserIngressResponse<A>(
  request: Request,
  invalidMessage: string,
  ingress: BrowserIngress<A>,
): Promise<Response> {
  const parsed = Effect.tryPromise({
    try: () => request.json(),
    catch: () => new UiHostError("invalid_browser_wire", invalidMessage),
  }).pipe(
    Effect.flatMap((input) =>
      Effect.try(() => BrowserWireObjectSchema.parse(input)),
    ),
    Effect.flatMap(ingress),
  );
  try {
    return Response.json(await runPromiseAtBoundary(parsed, request.signal));
  } catch (error) {
    return errorResponse(error);
  }
}

/** Build one Session browser host: its Mycelium `ui` module and HTTP transport. */
export function createUiHost(
  runtime: EffectUiHost = Effect.runSync(makeEffect()),
): UiHostFacade {
  const module = Mycelium.module({
    id: "knapsack-ui",
    name: "ui",
    description: "Live semantic commands from the connected browser",
    operations: {
      discover: Mycelium.operation({
        replay: "safe",
        description: "Discover commands in the connected browser",
        input: z.object({}),
        output: browserCommandDiscoverySchema,
        execute: (_input, context) =>
          runPromiseAtBoundary(
            discoveryRequest(runtime, { type: "discover" }).pipe(
              Effect.map(discoveryResult),
            ),
            context.signal,
          ),
      }),
      execute: Mycelium.operation({
        replay: "unsafe",
        description: "Execute one discovered command in the connected browser",
        input: BrowserExecuteInputSchema,
        output: browserCommandExecutionSchema,
        execute: (input, context) =>
          runPromiseAtBoundary(
            executionRequest(runtime, { type: "execute", ...input }).pipe(
              Effect.map(executionResult),
            ),
            context.signal,
          ),
      }),
    },
  });

  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/browser/events")
      return eventResponse(runtime);
    if (request.method === "POST" && url.pathname === "/browser/claims")
      return browserIngressResponse(
        request,
        "Browser claim is invalid",
        runtime.claim,
      );
    if (request.method === "POST" && url.pathname === "/browser/results")
      return browserIngressResponse(
        request,
        "Browser result is invalid",
        runtime.acceptResult,
      );
    return Response.json({ error: "Not found" }, { status: 404 });
  };

  return Object.freeze({ modules: [module], fetch });
}
