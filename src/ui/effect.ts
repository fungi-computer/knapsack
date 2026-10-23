import * as Semaphore from "effect/Semaphore";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import { claimThenSettle } from "@fungi.computer/mycelium/semaphore-transition";

import {
  uiWireIds,
  BrowserClaimSchema,
  BrowserResultEnvelopeSchema,
  type BrowserRequest,
  type BrowserRequestEnvelope,
  type BrowserClaim,
  type BrowserClaimResult,
  type BrowserWireResult,
  type BrowserSettlementResult,
  type BrowserWireObject,
} from "./wire.js";

const decodeResultEnvelope = (input: BrowserWireObject) =>
  Effect.try(() => BrowserResultEnvelopeSchema.parse(input));
const decodeClaim = (input: BrowserWireObject) =>
  Effect.try(() => BrowserClaimSchema.parse(input));

export type UiHostErrorCode =
  | "browser_busy"
  | "browser_disconnected"
  | "browser_execution_indeterminate"
  | "browser_not_connected"
  | "invalid_browser_wire";

/** Closed failure vocabulary for the connected-browser request boundary. */
export class UiHostError extends Error {
  public constructor(
    public readonly code: UiHostErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UiHostError";
  }
}

type ActiveConnection = Readonly<{
  id: string;
  requests: Queue.Queue<BrowserRequestEnvelope>;
}>;

type BrowserClaimLease = Readonly<{
  attemptId: string;
  claimId: string;
  connectionId: string;
  expiresAt: number;
}>;

type PendingRequest = Readonly<{
  requestId: string;
  request: BrowserRequest;
  cancelled: boolean;
  expected: BrowserRequest["type"];
  phase: "claimed" | "queued";
  claim: BrowserClaimLease | undefined;
  result: Deferred.Deferred<BrowserWireResult, UiHostError>;
}>;

type Disconnection = Readonly<{
  connection: ActiveConnection;
  failed: PendingRequest | undefined;
  reoffer: BrowserRequestEnvelope | undefined;
  recipients: readonly ActiveConnection[];
}>;

/** One scope-owned live browser connection. */
export type UiHostConnection = Readonly<{
  id: string;
  take: Effect.Effect<BrowserRequestEnvelope>;
}>;

export type UiHostOptions = Readonly<{ claimLeaseMs?: number }>;

/** Canonical Effect-owned browser host execution and connection lifecycle. */
export type UiHost = Readonly<{
  connect: () => Effect.Effect<UiHostConnection, never, Scope.Scope>;
  request: (
    request: BrowserRequest,
  ) => Effect.Effect<BrowserWireResult, UiHostError>;
  claim: (
    input: Parameters<typeof decodeClaim>[0],
  ) => Effect.Effect<BrowserClaimResult, UiHostError>;
  acceptResult: (
    input: Parameters<typeof decodeResultEnvelope>[0],
  ) => Effect.Effect<BrowserSettlementResult, UiHostError>;
}>;

function disconnected(request: PendingRequest): UiHostError {
  return request.expected === "execute" && request.phase === "claimed"
    ? new UiHostError(
        "browser_execution_indeterminate",
        "The browser disconnected after execution dispatch",
      )
    : new UiHostError(
        "browser_disconnected",
        "The connected browser disconnected before returning a result",
      );
}

function activeClaimResult(
  lease: BrowserClaimLease | undefined,
  claimed: BrowserClaim,
  now: number,
  connected: ReadonlySet<string>,
): BrowserClaimResult | undefined {
  if (
    lease === undefined ||
    lease.expiresAt <= now ||
    !connected.has(lease.connectionId)
  )
    return undefined;
  if (
    lease.connectionId === claimed.connectionId &&
    lease.attemptId === claimed.attemptId
  )
    return { status: "claimed", claimId: lease.claimId };
  return {
    status: "waiting",
    retryAfterMs: Math.max(10, Math.min(1_000, lease.expiresAt - now)),
  };
}

function hasExpiredClaim(lease: BrowserClaimLease | undefined, now: number) {
  return lease !== undefined && lease.expiresAt <= now;
}

function ownsLiveClaim(
  request: PendingRequest,
  claimId: string,
  now: number,
): boolean {
  return (
    request.phase === "claimed" &&
    request.claim?.claimId === claimId &&
    !hasExpiredClaim(request.claim, now)
  );
}

/** Construct the single Effect-owned connected-browser runtime. */
export function make(options: UiHostOptions = {}): Effect.Effect<UiHost> {
  return Effect.gen(function* () {
    const gate = yield* Semaphore.make(1);
    const connections = new Map<string, ActiveConnection>();
    const requestedClaimLeaseMs = options.claimLeaseMs ?? 30_000;
    const claimLeaseMs = Number.isFinite(requestedClaimLeaseMs)
      ? Math.max(100, Math.min(60_000, requestedClaimLeaseMs))
      : 30_000;
    let pending: PendingRequest | undefined;

    const claimDisconnection = (
      connection: ActiveConnection,
    ): Disconnection => {
      connections.delete(connection.id);
      let failed: PendingRequest | undefined;
      let reoffer: BrowserRequestEnvelope | undefined;
      if (
        pending?.phase === "claimed" &&
        pending.claim?.connectionId === connection.id
      ) {
        if (connections.size > 0) {
          pending = { ...pending, phase: "queued", claim: undefined };
          reoffer = {
            requestId: pending.requestId,
            request: pending.request,
          };
        } else {
          failed = pending;
          pending = undefined;
        }
      } else if (pending !== undefined && connections.size === 0) {
        failed = pending;
        pending = undefined;
      }
      return {
        connection,
        failed,
        reoffer,
        recipients: [...connections.values()],
      };
    };

    const settleDisconnection = (
      disconnection: Disconnection,
    ): Effect.Effect<void> => {
      const reoffer = disconnection.reoffer;
      return (
        disconnection.failed === undefined
          ? Effect.void
          : Deferred.fail(
              disconnection.failed.result,
              disconnected(disconnection.failed),
            ).pipe(Effect.asVoid)
      ).pipe(
        Effect.andThen(
          reoffer === undefined
            ? Effect.void
            : Effect.forEach(
                disconnection.recipients,
                (recipient) => Queue.offer(recipient.requests, reoffer),
                { discard: true },
              ),
        ),
        Effect.andThen(Queue.shutdown(disconnection.connection.requests)),
      );
    };

    const disconnect = (connection: ActiveConnection): Effect.Effect<void> =>
      claimThenSettle(
        gate,
        () => claimDisconnection(connection),
        settleDisconnection,
      );

    const connect = (): Effect.Effect<UiHostConnection, never, Scope.Scope> =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const requests = yield* Queue.sliding<BrowserRequestEnvelope>(1);
          const connection: ActiveConnection = {
            id: uiWireIds.connection.generate(),
            requests,
          };
          yield* gate.withPermits(1)(
            Effect.sync(() => {
              connections.set(connection.id, connection);
              if (pending !== undefined && !pending.cancelled)
                Queue.offerUnsafe(connection.requests, {
                  requestId: pending.requestId,
                  request: pending.request,
                });
            }),
          );
          return connection;
        }),
        disconnect,
      ).pipe(
        Effect.map((connection) => {
          const take = (): Effect.Effect<BrowserRequestEnvelope> =>
            Queue.take(connection.requests).pipe(
              Effect.flatMap((envelope) =>
                gate
                  .withPermits(1)(
                    Effect.sync(() => {
                      const owned = pending;
                      return (
                        owned?.requestId === envelope.requestId &&
                        connections.has(connection.id)
                      );
                    }),
                  )
                  .pipe(
                    Effect.flatMap((live) =>
                      live ? Effect.succeed(envelope) : Effect.suspend(take),
                    ),
                  ),
              ),
            );
          return Object.freeze({
            id: connection.id,
            take: Effect.suspend(take),
          });
        }),
      );

    const markCancelled = (requestId: string): Effect.Effect<void> =>
      claimThenSettle(
        gate,
        () => {
          if (pending?.requestId === requestId)
            pending = { ...pending, cancelled: true };
        },
        () => Effect.void,
      );

    const request = (
      browserRequest: BrowserRequest,
    ): Effect.Effect<BrowserWireResult, UiHostError> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const result = yield* Deferred.make<BrowserWireResult, UiHostError>();
          let requestId: string | undefined;
          const run = claimThenSettle(
            gate,
            () => {
              if (connections.size === 0) return { status: "offline" } as const;
              if (pending !== undefined) return { status: "busy" } as const;
              const id = uiWireIds.request.generate();
              const envelope = {
                requestId: id,
                request: browserRequest,
              } satisfies BrowserRequestEnvelope;
              pending = {
                requestId: id,
                request: browserRequest,
                cancelled: false,
                expected: browserRequest.type,
                phase: "queued",
                claim: undefined,
                result,
              };
              for (const connection of connections.values())
                Queue.offerUnsafe(connection.requests, envelope);
              requestId = id;
              return { status: "admitted" } as const;
            },
            (admission) => {
              if (admission.status === "offline")
                return Effect.fail(
                  new UiHostError(
                    "browser_not_connected",
                    "No browser is connected",
                  ),
                );
              if (admission.status === "busy")
                return Effect.fail(
                  new UiHostError(
                    "browser_busy",
                    "The connected browser already has pending work",
                  ),
                );
              return Effect.void;
            },
          ).pipe(Effect.andThen(Deferred.await(result)));
          return yield* restore(run).pipe(
            Effect.onInterrupt(() =>
              requestId === undefined ? Effect.void : markCancelled(requestId),
            ),
          );
        }),
      );

    const claim = (
      input: Parameters<typeof decodeClaim>[0],
    ): Effect.Effect<BrowserClaimResult, UiHostError> =>
      decodeClaim(input).pipe(
        Effect.mapError(
          () =>
            new UiHostError("invalid_browser_wire", "Browser claim is invalid"),
        ),
        Effect.flatMap((claimed) =>
          claimThenSettle(
            gate,
            () => {
              const owned = pending;
              if (owned?.requestId !== claimed.requestId)
                return { status: "skipped" } as const;
              if (owned.cancelled) {
                pending = undefined;
                return { status: "skipped" } as const;
              }

              const now = Date.now();
              const active = activeClaimResult(
                owned.claim,
                claimed,
                now,
                new Set(connections.keys()),
              );
              if (active !== undefined) return active;

              if (!connections.has(claimed.connectionId))
                return { status: "skipped" } as const;
              const lease: BrowserClaimLease = {
                attemptId: claimed.attemptId,
                claimId: uiWireIds.claim.generate(),
                connectionId: claimed.connectionId,
                expiresAt: now + claimLeaseMs,
              };
              pending = { ...owned, phase: "claimed", claim: lease };
              return { status: "claimed", claimId: lease.claimId } as const;
            },
            Effect.succeed,
          ),
        ),
      );

    const acceptResult = (
      input: Parameters<typeof decodeResultEnvelope>[0],
    ): Effect.Effect<BrowserSettlementResult, UiHostError> =>
      decodeResultEnvelope(input).pipe(
        Effect.mapError(
          () =>
            new UiHostError(
              "invalid_browser_wire",
              "Browser result is invalid",
            ),
        ),
        Effect.flatMap((envelope) =>
          claimThenSettle(
            gate,
            () => {
              const owned = pending;
              if (owned?.requestId !== envelope.requestId)
                return { status: "ignored" } as const;
              const now = Date.now();
              if (!ownsLiveClaim(owned, envelope.claimId, now)) {
                if (hasExpiredClaim(owned.claim, now))
                  pending = { ...owned, phase: "queued", claim: undefined };
                return { status: "ignored" } as const;
              }
              pending = undefined;
              if (owned.expected !== envelope.result.type) {
                const failure = new UiHostError(
                  "invalid_browser_wire",
                  "Browser result does not match its request",
                );
                return { status: "mismatch", owned, failure } as const;
              }
              return { status: "accepted", owned } as const;
            },
            (settlement) => {
              if (settlement.status === "ignored")
                return Effect.succeed({ status: "ignored" } as const);
              if (settlement.status === "mismatch")
                return Deferred.fail(
                  settlement.owned.result,
                  settlement.failure,
                ).pipe(Effect.andThen(Effect.fail(settlement.failure)));
              return Deferred.succeed(
                settlement.owned.result,
                envelope.result,
              ).pipe(
                Effect.as<BrowserSettlementResult>({ status: "accepted" }),
              );
            },
          ),
        ),
      );

    return Object.freeze({ connect, request, claim, acceptResult });
  });
}
