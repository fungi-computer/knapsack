import type {
  WhistleAction,
  WhistleExecutionOutcome,
  WhistleRuntime,
} from "@fungi.computer/whistle";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as z from "zod";

import {
  type BrowserClaimResult,
  BrowserClaimResultSchema,
  BrowserCommandRowSchema,
  type BrowserCommandRow,
  type BrowserRequestEnvelope,
  BrowserRequestDeliverySchema,
  type BrowserRequestDelivery,
  type BrowserResultEnvelope,
  BrowserSettlementResultSchema,
  type BrowserWireObject,
} from "./wire.js";
import { uiWireIds, BrowserExecutionOutcomeSchema } from "./wire.js";

/** Browser-side platform failure before a correlated result is accepted. */
export class UiBrowserError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UiBrowserError";
  }
}

/** One Agent Session's browser transport and the App's command runtime. */
export type BrowserConnectionOptions = Readonly<{
  /** Session route that serves `/browser/{events,claims,results}`. */
  baseUrl: string;
  /** The App shell's Whistle runtime; its agent projection is what the Agent sees. */
  whistle: Pick<WhistleRuntime, "snapshot" | "execute">;
  /** Host-authorized I/O; omitted for ordinary browser Fetch and EventSource. */
  transport?: Readonly<{
    /** Send claims and results with the host's existing admission. */
    fetch: typeof globalThis.fetch;
    /** Open the event stream with that same admission and a maintained SSE client. */
    openEvents: (url: string) => EventTarget & {
      /** Stop this connection's event stream when its owning scope closes. */
      close(): void;
    };
  }>;
}>;

/** A live browser connection; close it when the selected Session changes. */
export type BrowserConnection = Readonly<{
  /** Settles when the connection ends; rejects with {@link UiBrowserError} on failure. */
  closed: Promise<void>;
  /** Stop serving the Agent's requests. */
  close: () => void;
}>;

type ProjectedWhistleAction = {
  inputSchema?: WhistleAction["inputSchema"];
  outputSchema?: WhistleAction["outputSchema"];
};

const decodeRequestEvent = (input: string) =>
  Effect.try(() =>
    BrowserRequestDeliverySchema.parse(JSON.parse(z.string().parse(input))),
  );
const decodeClaimResult = (input: BrowserWireObject) =>
  Effect.try(() => BrowserClaimResultSchema.parse(input));
const decodeSettlementResult = (input: BrowserWireObject) =>
  Effect.try(() => BrowserSettlementResultSchema.parse(input));

function requestEventData(event: Event): Effect.Effect<string, UiBrowserError> {
  return event instanceof MessageEvent
    ? Effect.try(() => z.string().parse(event.data)).pipe(
        Effect.mapError(
          () => new UiBrowserError("Browser request event is invalid"),
        ),
      )
    : Effect.fail(new UiBrowserError("Browser request event is invalid"));
}

function projectCommands(
  whistle: Pick<WhistleRuntime, "snapshot">,
): Effect.Effect<BrowserCommandRow[]> {
  return Effect.sync(() =>
    BrowserCommandRowSchema.array().parse(
      whistle.snapshot().agent.map((row) => {
        const sourceAction = row.action;
        // Focus scope belongs to the local command graph, not the browser wire.
        const projected = {
          command: { namespace: row.command.namespace, id: row.command.id },
          sourceId: row.sourceId,
          title: row.title,
          category: row.category,
          description: row.description ?? null,
          order: row.order,
          keybind: row.keybind ?? null,
          availability: row.availability,
        };
        if (sourceAction === undefined) return projected;
        const action: ProjectedWhistleAction = {};
        if (sourceAction.inputSchema !== undefined)
          action.inputSchema = sourceAction.inputSchema;
        if (sourceAction.outputSchema !== undefined)
          action.outputSchema = sourceAction.outputSchema;
        if (
          action.inputSchema === undefined &&
          action.outputSchema === undefined
        )
          return projected;
        return { ...projected, action };
      }),
    ),
  );
}

function projectOutcome(
  outcome: WhistleExecutionOutcome,
): BrowserResultEnvelope["result"] {
  const parsed = BrowserExecutionOutcomeSchema.safeParse(outcome);
  return {
    type: "execute",
    outcome: parsed.success
      ? parsed.data
      : {
          status: "failed",
          error: {
            code: "invalid_command_result",
            message: "Command result is not valid JSON data",
          },
        },
  };
}

/**
 * Execute one claimed browser request through Whistle's single door.
 *
 * Claim is the dispatch point: the browser request carries no cancellation, so
 * Whistle supplies its own never-aborted signal, and cancellation after this
 * function starts cannot promise to undo a side effect.
 */
export function handleBrowserRequest(
  options: BrowserConnectionOptions,
  envelope: BrowserRequestEnvelope,
): Effect.Effect<Omit<BrowserResultEnvelope, "claimId">, UiBrowserError> {
  if (envelope.request.type === "discover")
    return projectCommands(options.whistle).pipe(
      Effect.map((commands) => ({
        requestId: envelope.requestId,
        result: { type: "discover", commands },
      })),
    );
  const command = envelope.request.command;
  const argumentsValue =
    "arguments" in envelope.request ? envelope.request.arguments : undefined;
  return Effect.tryPromise({
    try: () =>
      options.whistle.execute(
        command,
        argumentsValue === undefined
          ? { origin: "agent" }
          : { origin: "agent", arguments: argumentsValue },
      ),
    catch: () => new UiBrowserError("Whistle execution rejected"),
  }).pipe(
    Effect.map((outcome) => ({
      requestId: envelope.requestId,
      result: projectOutcome(outcome),
    })),
  );
}

function claimRequest(
  options: BrowserConnectionOptions,
  delivery: BrowserRequestDelivery,
): Effect.Effect<BrowserClaimResult, UiBrowserError> {
  const attemptId = uiWireIds.attempt.generate();
  const claimOnce = (): Effect.Effect<BrowserClaimResult, UiBrowserError> =>
    Effect.tryPromise({
      try: (signal) =>
        (options.transport?.fetch ?? globalThis.fetch)(
          `${options.baseUrl}/browser/claims`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              attemptId,
              connectionId: delivery.connectionId,
              requestId: delivery.requestId,
            }),
            signal,
          },
        ),
      catch: () => new UiBrowserError("Browser claim request failed"),
    }).pipe(
      Effect.flatMap((response) =>
        response.ok
          ? Effect.tryPromise({
              try: () => response.json(),
              catch: () =>
                new UiBrowserError("Browser claim response is invalid"),
            })
          : Effect.fail(
              new UiBrowserError(
                `Browser claim was rejected with status ${String(response.status)}`,
              ),
            ),
      ),
      Effect.flatMap((input) =>
        Effect.try(() => z.record(z.string(), z.unknown()).parse(input)).pipe(
          Effect.flatMap(decodeClaimResult),
        ),
      ),
      Effect.mapError(
        () => new UiBrowserError("Browser claim response is invalid"),
      ),
    );
  const waitForClaim = (): Effect.Effect<BrowserClaimResult, UiBrowserError> =>
    claimOnce().pipe(
      Effect.flatMap((claim) =>
        claim.status === "waiting"
          ? Effect.sleep(claim.retryAfterMs).pipe(
              Effect.andThen(Effect.suspend(waitForClaim)),
            )
          : Effect.succeed(claim),
      ),
    );
  return Effect.suspend(waitForClaim);
}

function postResult(
  options: BrowserConnectionOptions,
  result: BrowserResultEnvelope,
): Effect.Effect<void, UiBrowserError> {
  return Effect.tryPromise({
    try: (signal) =>
      (options.transport?.fetch ?? globalThis.fetch)(
        `${options.baseUrl}/browser/results`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(result),
          signal,
        },
      ),
    catch: () => new UiBrowserError("Browser result request failed"),
  }).pipe(
    Effect.flatMap((response) =>
      response.ok
        ? Effect.tryPromise({
            try: () => response.json(),
            catch: () =>
              new UiBrowserError("Browser settlement response is invalid"),
          }).pipe(
            Effect.flatMap((input) =>
              Effect.try(() =>
                z.record(z.string(), z.unknown()).parse(input),
              ).pipe(Effect.flatMap(decodeSettlementResult)),
            ),
            Effect.mapError(
              () =>
                new UiBrowserError("Browser settlement response is invalid"),
            ),
            Effect.asVoid,
          )
        : Effect.fail(
            new UiBrowserError(
              `Browser result was rejected with status ${String(response.status)}`,
            ),
          ),
    ),
  );
}

function handleRequestEvent(
  options: BrowserConnectionOptions,
  event: Event,
): Effect.Effect<void, UiBrowserError> {
  return requestEventData(event).pipe(
    Effect.flatMap(decodeRequestEvent),
    Effect.mapError(
      () => new UiBrowserError("Browser request payload is invalid"),
    ),
    Effect.flatMap((delivery) =>
      claimRequest(options, delivery).pipe(
        Effect.flatMap((claim) =>
          claim.status !== "claimed"
            ? Effect.void
            : handleBrowserRequest(options, delivery).pipe(
                Effect.flatMap((result) =>
                  postResult(options, {
                    ...result,
                    claimId: claim.claimId,
                  }),
                ),
              ),
        ),
      ),
    ),
  );
}

/** Run one scope-owned EventSource connection and its Whistle request loop. */
export function runBrowserConnection(
  options: BrowserConnectionOptions,
): Effect.Effect<void, UiBrowserError, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.try({
      try: () => {
        const url = `${options.baseUrl}/browser/events`;
        return options.transport === undefined
          ? new EventSource(url)
          : options.transport.openEvents(url);
      },
      catch: () => new UiBrowserError("Browser event stream could not open"),
    }),
    (source) =>
      Effect.sync(() => {
        source.close();
      }),
  ).pipe(
    Effect.flatMap((source) =>
      Stream.fromEventListener<Event>(source, "browser-request", {
        bufferSize: 1,
      }).pipe(
        Stream.mapEffect((event) => handleRequestEvent(options, event)),
        Stream.runDrain,
      ),
    ),
  );
}

/** Start the named browser Promise facade over the Effect connection program. */
export function connectBrowser(
  options: BrowserConnectionOptions,
): BrowserConnection {
  const cancellation = new AbortController();
  const closed = Effect.runPromise(
    Effect.scoped(runBrowserConnection(options)),
    {
      signal: cancellation.signal,
    },
  ).catch((cause: unknown) => {
    if (!cancellation.signal.aborted)
      throw new UiBrowserError("Browser connection failed", {
        cause,
      });
  });
  return Object.freeze({
    closed,
    close: () => {
      cancellation.abort();
    },
  });
}
