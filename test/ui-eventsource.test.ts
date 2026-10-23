import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import {
  EventSource as MaintainedEventSource,
  type EventSourceFetchInit,
} from "eventsource";
import { Mycelium } from "@fungi.computer/mycelium";
import { directSandbox } from "@fungi.computer/mycelium/testing";
import { createWhistle, type WhistleRuntime } from "@fungi.computer/whistle";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { inspect } from "node:util";
import * as Stream from "effect/Stream";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  UiBrowserError,
  connectBrowser,
  type BrowserConnection,
} from "../src/ui/browser.js";
import { createUiHost } from "../src/ui/host.js";
import { make } from "../src/ui/effect.js";
import {
  BrowserClaimResultSchema,
  BrowserRequestDeliverySchema,
} from "../src/ui/wire.js";

type Observation = Readonly<{
  atMs: number;
  client: string;
  event: string;
  detail: string | undefined;
}>;

type DeliveryObservation = Readonly<{
  client: string;
  connectionId: string;
  requestId: string;
}>;

type ClaimObservation = Readonly<{
  connectionId: string;
  requestId: string;
  status: string;
}>;

type NativeClaimHold = {
  next: boolean;
  observed: boolean;
  connectionId: string | undefined;
};

type NativeServerState = Readonly<{
  facade: ReturnType<typeof createUiHost>;
  claims: ClaimObservation[];
  claimHold: NativeClaimHold;
  heldClaimResponse: Promise<void>;
  observe: (client: string, event: string, detail?: string) => void;
}>;

const wait = (durationMs: number) =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

async function incomingRequest(
  incoming: IncomingMessage,
): Promise<Request | null> {
  const body = await incomingBody(incoming);
  const headers = incomingHeaders(incoming.headers);
  const host = incoming.headers.host;
  if (host === undefined) return null;
  const init: RequestInit = {
    method: incoming.method ?? "GET",
    headers,
  };
  if (body.byteLength > 0) init.body = body;
  return new Request(`http://${host}${incoming.url ?? "/"}`, init);
}

async function incomingBody(
  incoming: IncomingMessage,
): Promise<Buffer<ArrayBuffer>> {
  const parts: Uint8Array[] = [];
  for await (const part of incoming)
    parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
  return Buffer.concat(parts);
}

function incomingHeaders(source: IncomingMessage["headers"]): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value])
      headers.append(name, item);
  }
  return headers;
}

async function waitForClaimResponse(
  state: NativeServerState,
  request: Request,
  response: Response,
): Promise<Response> {
  const input = z
    .looseObject({ connectionId: z.string(), requestId: z.string() })
    .parse(await request.clone().json());
  const result = BrowserClaimResultSchema.parse(await response.clone().json());
  state.claims.push({ ...input, status: result.status });
  if (!state.claimHold.next || result.status !== "claimed") return response;
  state.claimHold.next = false;
  state.claimHold.observed = true;
  state.claimHold.connectionId = input.connectionId;
  await state.heldClaimResponse;
  return state.facade.fetch(request);
}

async function pipeResponseBody(
  outgoing: ServerResponse,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  for (;;) {
    const next = await reader.read();
    if (next.done) return;
    if (!outgoing.write(next.value)) await once(outgoing, "drain");
  }
}

function reportFailure(operation: string, cause: unknown): void {
  console.error(
    JSON.stringify({
      source: "knapsack-ui-native-proof",
      operation,
      failureKind: cause instanceof Error ? "Error" : "NonErrorThrown",
    }),
    Redacted.make(cause),
  );
}

async function writeProxiedResponse(
  outgoing: ServerResponse,
  response: Response,
  pathname: string,
  client: string,
  observe: NativeServerState["observe"],
): Promise<void> {
  outgoing.writeHead(
    response.status,
    Object.fromEntries(response.headers.entries()),
  );
  outgoing.flushHeaders();
  if (response.body === null) {
    outgoing.end();
    return;
  }
  const reader = response.body.getReader();
  const cancelOnClose = () => {
    if (!outgoing.writableEnded)
      void reader.cancel().catch((cause: unknown) => {
        reportFailure(`cancel-response:${client}:${pathname}`, cause);
      });
  };
  outgoing.once("close", cancelOnClose);
  try {
    await pipeResponseBody(outgoing, reader);
    if (pathname === "/browser/events") observe(client, "http-end");
    outgoing.end();
  } catch (error) {
    reportFailure(`response-body:${client}:${pathname}`, error);
    if (pathname === "/browser/events")
      observe(
        client,
        "http-body-error",
        error instanceof Error ? error.message : String(error),
      );
    if (!outgoing.destroyed && !outgoing.writableEnded) outgoing.end();
  } finally {
    outgoing.off("close", cancelOnClose);
    reader.releaseLock();
  }
}

async function handleNativeRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  state: NativeServerState,
): Promise<void> {
  const request = await incomingRequest(incoming);
  if (request === null) {
    outgoing.writeHead(400).end();
    return;
  }
  const url = new URL(request.url);
  const client = request.headers.get("x-knapsack-ui-client") ?? "host";
  try {
    const claimReplay =
      url.pathname === "/browser/claims" ? request.clone() : undefined;
    let response = await state.facade.fetch(request);
    if (url.pathname === "/browser/events")
      state.observe(client, "http-open", `status=${String(response.status)}`);
    if (response.ok && claimReplay !== undefined)
      response = await waitForClaimResponse(state, claimReplay, response);
    await writeProxiedResponse(
      outgoing,
      response,
      url.pathname,
      client,
      state.observe,
    );
  } catch (error) {
    reportFailure(`serve-request:${client}:${url.pathname}`, error);
    state.observe(client, "http-failure", String(error));
    if (!outgoing.headersSent) outgoing.writeHead(500);
    outgoing.end();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("retains the cause when a browser connection fails", async () => {
  vi.stubGlobal("EventSource", MaintainedEventSource);
  const connection = connectBrowser({
    baseUrl: "not-a-url",
    whistle: createWhistle(),
  });

  const failure = await connection.closed.then(
    () => {
      throw new Error("The invalid browser URL unexpectedly connected");
    },
    (cause: unknown) => cause,
  );
  expect(failure).toBeInstanceOf(UiBrowserError);
  if (!(failure instanceof UiBrowserError))
    throw new Error("The browser connection failed with the wrong error");
  expect(failure.cause).toBeInstanceOf(UiBrowserError);
});

it("fans requests to two and three native tabs with one leased claimant and no reconnect churn", async () => {
  const startedAt = performance.now();
  const observations: Observation[] = [];
  const deliveries: DeliveryObservation[] = [];
  const claims: ClaimObservation[] = [];
  const sources = new Set<string>();
  const executionCounts = new Map<string, number>();
  const facade = createUiHost(Effect.runSync(make({ claimLeaseMs: 500 })));
  let sourceSequence = 0;
  const claimHold: NativeClaimHold = {
    next: false,
    observed: false,
    connectionId: undefined,
  };
  let releaseHeldClaim: () => void = () => undefined;
  const heldClaimResponse = new Promise<void>((resolve) => {
    releaseHeldClaim = resolve;
  });

  const observe = (client: string, event: string, detail?: string) => {
    observations.push({
      atMs: Math.round(performance.now() - startedAt),
      client,
      event,
      detail,
    });
  };

  const serverState: NativeServerState = {
    facade,
    claims,
    claimHold,
    heldClaimResponse,
    observe,
  };

  class ObservedEventSource extends MaintainedEventSource {
    public readonly clientId: string;

    public constructor(url: string) {
      const clientId = `client-${String(++sourceSequence)}`;
      super(url, {
        fetch: async (input: string | URL, init: EventSourceFetchInit) => {
          const headers = new Headers(init.headers);
          headers.set("x-knapsack-ui-client", clientId);
          return await fetch(input, { ...init, headers });
        },
      });
      this.clientId = clientId;
      sources.add(clientId);
      executionCounts.set(clientId, 0);
      this.addEventListener("open", () => {
        observe(clientId, "open");
      });
      this.addEventListener("error", () => {
        observe(clientId, "error");
      });
      this.addEventListener("browser-request", (event) => {
        if (!(event instanceof MessageEvent))
          throw new Error("Knapsack.ui request event was not a text message");
        const delivery = BrowserRequestDeliverySchema.parse(
          JSON.parse(z.string().parse(event.data)),
        );
        deliveries.push({
          client: clientId,
          connectionId: delivery.connectionId,
          requestId: delivery.requestId,
        });
        observe(clientId, "delivery", delivery.requestId);
      });
    }

    public override close(): void {
      observe(this.clientId, "close");
      super.close();
    }
  }

  vi.stubGlobal("EventSource", ObservedEventSource);

  const server = createServer((incoming, outgoing) => {
    void handleNativeRequest(incoming, outgoing, serverState);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = z
    .object({ port: z.number().int().min(1).max(65_535) })
    .parse(server.address()).port;
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const runtime = await Mycelium.make({
    modules: facade.modules,
    sandbox: directSandbox(async (bindings) => {
      const ui = bindings.ui;
      if (ui === undefined) throw new Error("Missing ui capability");
      const discover = ui.discover;
      if (discover === undefined) throw new Error("Missing ui.discover");
      return await discover({});
    }),
  });
  const lease = await runtime.acquire();
  const connections: BrowserConnection[] = [];
  let probeSequence = 0;

  const discoverOwner = async (): Promise<string> => {
    const probe = ++probeSequence;
    const prepared = await Effect.runPromise(
      lease.executeTool.prepare({
        type: "toolCall",
        id: `eventsource-probe-${String(probe)}`,
        name: "execute",
        arguments: { code: "discover" },
      }),
    );
    const parts = await Effect.runPromise(
      Stream.runCollect(prepared.execute()).pipe(),
    );
    const text = z
      .looseObject({ text: z.string() })
      .parse(parts[0]?.result.content[0]).text;
    const discovery = z
      .object({
        status: z.string().optional(),
        commands: z.array(z.object({ sourceId: z.string() })).optional(),
      })
      .parse(JSON.parse(text));
    const owner = discovery.commands?.[0]?.sourceId;
    observe("hub", `probe-${String(probe)}`, owner ?? discovery.status);
    return owner ?? discovery.status ?? "unknown";
  };

  const addClient = async (client: string): Promise<void> => {
    const connection = connectBrowser({
      baseUrl,
      whistle: whistleFor(client, () => {
        executionCounts.set(client, (executionCounts.get(client) ?? 0) + 1);
      }),
    });
    connections.push(connection);
    await waitFor(() => openCount(client) === 1);
  };

  try {
    await addClient("client-1");
    await addClient("client-2");
    const twoClientOwner = await discoverOwner();
    expect(["client-1", "client-2"]).toContain(twoClientOwner);
    const twoClientRequest = uniqueRequestId(0);
    expect(
      deliveriesFor(twoClientRequest)
        .map((item) => item.client)
        .sort(),
    ).toEqual(["client-1", "client-2"]);
    await waitFor(() =>
      claims.some(
        (item) =>
          item.requestId === twoClientRequest && item.status === "waiting",
      ),
    );
    const twoClientClaims = claims.filter(
      (item) =>
        item.requestId === twoClientRequest && item.status === "claimed",
    );
    expect(new Set(twoClientClaims.map((item) => item.connectionId)).size).toBe(
      1,
    );
    expect(executionTotal()).toBe(1);

    await addClient("client-3");
    claimHold.next = true;
    const threeClientProbe = discoverOwner();
    await waitFor(() => claimHold.observed, 1_000);
    await waitFor(
      () => new Set(deliveries.map((item) => item.requestId)).size >= 2,
    );
    const threeClientRequest = uniqueRequestId(1);
    const firstClaimConnection = claimHold.connectionId;
    if (firstClaimConnection === undefined)
      throw new Error("Missing the first leased connection");
    await waitFor(
      () =>
        claims.some(
          (item) =>
            item.requestId === threeClientRequest &&
            item.status === "claimed" &&
            item.connectionId !== firstClaimConnection,
        ),
      2_000,
    );
    releaseHeldClaim();
    const threeClientOwner = await threeClientProbe;
    expect(["client-1", "client-2", "client-3"]).toContain(threeClientOwner);

    expect(
      deliveriesFor(threeClientRequest)
        .map((item) => item.client)
        .sort(),
    ).toEqual(["client-1", "client-2", "client-3"]);
    const threeClientClaims = claims.filter(
      (item) =>
        item.requestId === threeClientRequest && item.status === "claimed",
    );
    expect(
      new Set(threeClientClaims.map((item) => item.connectionId)).size,
    ).toBe(2);
    expect(executionTotal()).toBe(2);

    await wait(6_500);
    expect(
      Object.fromEntries(
        [...sources].map((client) => [client, openCount(client)]),
      ),
    ).toEqual({
      "client-1": 1,
      "client-2": 1,
      "client-3": 1,
    });
    expect(
      observations.filter((item) => item.event === "http-open").length,
    ).toBe(3);

    process.stdout.write(
      `${JSON.stringify({
        proof: "knapsack-ui-multitab-fanout-claim-lease",
        requestIds: [twoClientRequest, threeClientRequest],
        deliveries,
        claims: claims.filter((item) =>
          [twoClientRequest, threeClientRequest].includes(item.requestId),
        ),
        executionCounts: Object.fromEntries(executionCounts),
        opens: Object.fromEntries(
          [...sources].map((client) => [client, openCount(client)]),
        ),
        lifecycle: observations.filter((item) =>
          ["http-open", "open", "error", "http-end", "close"].includes(
            item.event,
          ),
        ),
      })}\n`,
    );
  } finally {
    releaseHeldClaim();
    for (const connection of connections) connection.close();
    try {
      await Promise.all(connections.map((connection) => connection.closed));
    } finally {
      await lease.release();
      await runtime.close();
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }
  }

  function openCount(client: string): number {
    return observations.filter(
      (item) => item.client === client && item.event === "open",
    ).length;
  }

  function uniqueRequestId(index: number): string {
    const requestIds = [...new Set(deliveries.map((item) => item.requestId))];
    const requestId = requestIds[index];
    if (requestId === undefined)
      throw new Error(`Missing native request delivery ${String(index)}`);
    return requestId;
  }

  function deliveriesFor(requestId: string): DeliveryObservation[] {
    return deliveries.filter((item) => item.requestId === requestId);
  }

  function executionTotal(): number {
    return [...executionCounts.values()].reduce((sum, count) => sum + count, 0);
  }
}, 20_000);

function whistleFor(sourceId: string, onSnapshot: () => void) {
  const whistle = createWhistle();
  whistle.contribute({
    sourceId,
    namespace: "eventsource",
    commands: [
      {
        id: "identify",
        title: sourceId,
        category: "test",
        projections: { agent: { order: 1 } },
        handler: () => ({ sourceId }),
      },
    ],
  });
  const snapshot = whistle.snapshot.bind(whistle);
  const execute = whistle.execute.bind(whistle);
  return {
    snapshot: () => {
      onSnapshot();
      return snapshot();
    },
    execute: (...args: Parameters<typeof whistle.execute>) => execute(...args),
  } satisfies Pick<WhistleRuntime, "snapshot" | "execute">;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await wait(10);
  expect(predicate()).toBe(true);
}

it("retains the native proof failure without rendering its private cause", () => {
  const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const nested = new Error("synthetic-private-nested");
    const cause = new Error("synthetic-private-failure", { cause: nested });
    reportFailure("fixture-request", cause);
    const args = report.mock.calls[0];
    const retained: unknown = args?.[1];
    if (!Redacted.isRedacted(retained))
      throw new Error("Missing redacted cause");
    expect(Redacted.value(retained)).toBe(cause);
    expect(cause.cause).toBe(nested);
    for (const rendered of [
      JSON.stringify(args),
      String(args),
      inspect(args),
    ]) {
      expect(rendered).not.toContain(cause.message);
      expect(rendered).not.toContain(nested.message);
    }
  } finally {
    report.mockRestore();
  }
});
