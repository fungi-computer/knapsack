import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import { z } from "zod";

import { Knapsack } from "../../src/index.ts";

it("connects an MCP server on workerd without a redirect: error request", async () => {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "fixture", version: "1" });
    server.registerTool(
      "ping",
      { description: "Ping.", inputSchema: z.object({}) },
      () => ({ content: [{ type: "text", text: "pong" }] }),
    );
    return server;
  });
  // The host's fetch builds a Request from the SDK's init, as Connections do.
  const fetch = (url, init) => handler.fetch(new Request(url, init));
  const unavailable = [];
  const source = Knapsack.mcpServers({
    id: "agent-mcp",
    read: () =>
      Promise.resolve({
        version: "v1",
        servers: [
          {
            id: "mcp-open",
            name: "notes",
            url: new URL("https://open.test/mcp"),
          },
        ],
      }),
    subscribe: () => () => undefined,
    onUnavailable: (error) => unavailable.push(error),
    fetch,
  });
  const acquired = await source.acquire({
    signal: new AbortController().signal,
    invalidate: () => undefined,
  });
  try {
    expect(unavailable).toEqual([]);
    expect(acquired.snapshot.modules).toHaveLength(1);
  } finally {
    await acquired.release();
  }
});
