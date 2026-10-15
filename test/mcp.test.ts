import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { FetchLike } from "@modelcontextprotocol/client";
import { directSandbox } from "@fungi.computer/mycelium/testing";
import {
  Mycelium,
  type ModuleRegistration,
  type MyceliumJsonValue,
} from "@fungi.computer/mycelium";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  Knapsack,
  McpServerUnavailableError,
  type McpServerConnection,
} from "../src/index.js";

const token = "fixture-bearer-0123456789abcdef";

/** A real SDK MCP server: one read tool, one write tool, one awkward name. */
function fixtureServer() {
  const calls: unknown[] = [];
  const server = new McpServer({ name: "fixture", version: "1" });
  server.registerTool(
    "add",
    {
      description: "Add two numbers.",
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      outputSchema: z.object({ sum: z.number() }),
      annotations: { readOnlyHint: true },
    },
    ({ a, b }) => {
      calls.push({ a, b });
      return {
        content: [{ type: "text", text: String(a + b) }],
        structuredContent: { sum: a + b },
      };
    },
  );
  server.registerTool(
    "create-note",
    {
      description: "Create a note.",
      inputSchema: z.object({ text: z.string() }),
    },
    ({ text }) => {
      calls.push({ text });
      return { content: [{ type: "text", text: `saved ${text}` }] };
    },
  );
  server.registerTool(
    "fail",
    { description: "Always fails.", inputSchema: z.object({}) },
    () => ({ isError: true, content: [{ type: "text", text: "nope" }] }),
  );
  return { server, calls };
}

/** Route the SDK transport's requests to in-process MCP handlers by host. */
function fixtureFetch() {
  const { server, calls } = fixtureServer();
  const open = createMcpHandler(() => server);
  const guarded = createMcpHandler(() => fixtureServer().server);
  const authorizations: (string | null)[] = [];
  const fetch: FetchLike = async (url, init) => {
    const request = new Request(url, init);
    const host = new URL(request.url).host;
    if (host === "open.test") return open.fetch(request);
    if (host === "guarded.test") {
      const authorization = request.headers.get("authorization");
      authorizations.push(authorization);
      if (authorization !== `Bearer ${token}`)
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "www-authenticate": "Bearer" },
        });
      return guarded.fetch(request);
    }
    return Promise.reject(new TypeError("fetch failed"));
  };
  return { fetch, calls, authorizations };
}

function servers(...list: McpServerConnection[]) {
  return () => Promise.resolve({ version: "v1", servers: list });
}

const openServer: McpServerConnection = {
  id: "mcp-open",
  name: "notes",
  url: new URL("https://open.test/mcp"),
};

async function acquireModules(
  list: McpServerConnection[],
  fetch: FetchLike,
  unavailable: McpServerUnavailableError[] = [],
) {
  const source = Knapsack.mcpServers({
    id: "agent-mcp",
    read: servers(...list),
    subscribe: () => () => undefined,
    onUnavailable: (error) => unavailable.push(error),
    fetch,
  });
  return source.acquire({
    signal: new AbortController().signal,
    invalidate: () => undefined,
  });
}

/** Run one execute through Mycelium, calling the server module's operation. */
async function call(
  modules: readonly ModuleRegistration[],
  operation: string,
  input: MyceliumJsonValue,
): Promise<MyceliumJsonValue> {
  let value: MyceliumJsonValue = null;
  const runtime = await Mycelium.make({
    modules,
    sandbox: directSandbox(async (bindings) => {
      const binding = Object.values(bindings)
        .map((operations) => operations[operation])
        .find((candidate) => candidate !== undefined);
      if (binding === undefined) throw new Error(`No ${operation} binding`);
      value = await binding(input);
      return null;
    }),
  });
  const lease = await runtime.acquire();
  try {
    const prepared = await Effect.runPromise(
      lease.executeTool.prepare({
        type: "toolCall",
        id: "call",
        name: "execute",
        arguments: { code: `return mcp.${operation}(input)` },
      }),
    );
    const events = await Effect.runPromise(
      Stream.runCollect(prepared.execute()),
    );
    const failed = JSON.stringify(events).includes('"isError":true');
    if (failed) throw new Error(`execute failed: ${JSON.stringify(events)}`);
    return value;
  } finally {
    await lease.release();
    await runtime.close();
  }
}

describe("Knapsack.mcpServers", () => {
  it("lists a no-auth server's tools and calls them from codemode", async () => {
    const { fetch, calls } = fixtureFetch();
    const acquired = await acquireModules([openServer], fetch);
    try {
      expect(acquired.snapshot.version).toMatch(/^mcp-[0-9a-f]{64}$/u);
      expect(acquired.snapshot.modules).toHaveLength(1);
      const runtime = await Mycelium.make({
        modules: acquired.snapshot.modules,
        sandbox: directSandbox(() => Promise.resolve(null)),
      });
      const lease = await runtime.acquire();
      try {
        const types = lease.catalog.describe({ path: "mcp.notes.add" }).types;
        expect(types).toContain("a: number");
        expect(types).toContain("b: number");
        expect(
          lease.catalog.describe({ path: "mcp.notes.create_note" }).types,
        ).toContain("text: string");
      } finally {
        await lease.release();
        await runtime.close();
      }

      const sum = await call(acquired.snapshot.modules, "add", { a: 2, b: 3 });
      expect(sum).toEqual({ sum: 5 });
      const note = await call(acquired.snapshot.modules, "create_note", {
        text: "hi",
      });
      expect(note).toEqual({
        isError: false,
        content: [{ type: "text", text: "saved hi" }],
      });
      const failed = await call(acquired.snapshot.modules, "fail", {});
      expect(failed).toEqual({
        isError: true,
        content: [{ type: "text", text: "nope" }],
      });
      expect(calls).toEqual([{ a: 2, b: 3 }, { text: "hi" }]);
    } finally {
      await acquired.release();
    }
  });

  it("validates arguments against the advertised schema before calling", async () => {
    const { fetch, calls } = fixtureFetch();
    const acquired = await acquireModules([openServer], fetch);
    try {
      await expect(
        call(acquired.snapshot.modules, "add", { a: "two", b: 3 }),
      ).rejects.toThrow();
      expect(calls).toEqual([]);
    } finally {
      await acquired.release();
    }
  });

  it("sends the host-held bearer and fails closed without it", async () => {
    const { fetch, authorizations } = fixtureFetch();
    const unavailable: McpServerUnavailableError[] = [];
    const guarded = {
      id: "mcp-guarded",
      name: "guarded",
      url: new URL("https://guarded.test/mcp"),
    };
    const refused = await acquireModules([guarded], fetch, unavailable);
    expect(refused.snapshot.modules).toEqual([]);
    expect(unavailable.map((error) => [error.serverId, error.reason])).toEqual([
      ["mcp-guarded", "unauthorized"],
    ]);
    await refused.release();

    const admitted = await acquireModules(
      [{ ...guarded, headers: { authorization: `Bearer ${token}` } }],
      fetch,
    );
    try {
      expect(admitted.snapshot.modules).toHaveLength(1);
      expect(JSON.stringify(admitted.snapshot)).not.toContain(token);
      expect(
        await call(admitted.snapshot.modules, "add", { a: 1, b: 1 }),
      ).toEqual({ sum: 2 });
    } finally {
      await admitted.release();
    }
    expect(authorizations[0]).toBeNull();
    expect(
      authorizations.slice(1).every((value) => value === `Bearer ${token}`),
    ).toBe(true);
  });

  it("drops an unreachable server and keeps the others", async () => {
    const { fetch } = fixtureFetch();
    const unavailable: McpServerUnavailableError[] = [];
    const acquired = await acquireModules(
      [
        {
          id: "mcp-down",
          name: "down",
          url: new URL("https://down.test/mcp"),
        },
        openServer,
      ],
      fetch,
      unavailable,
    );
    try {
      expect(acquired.snapshot.modules).toHaveLength(1);
      expect(unavailable).toHaveLength(1);
      expect(unavailable[0]).toBeInstanceOf(McpServerUnavailableError);
      expect(unavailable[0]?.serverId).toBe("mcp-down");
      expect(unavailable[0]?.reason).toBe("rejected");
    } finally {
      await acquired.release();
    }
  });
});
