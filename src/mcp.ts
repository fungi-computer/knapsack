import type { Client, FetchLike, Tool } from "@modelcontextprotocol/client";
import {
  Mycelium,
  type CapabilitySource,
  type ModuleRegistration,
  type OperationRegistration,
} from "@fungi.computer/mycelium";
import { jsonSchemaSubset } from "@fungi.computer/forage/json-schema-subset";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { z } from "zod";

const maximumServers = 16;
const maximumTools = 256;
const maximumToolPages = 16;
const connectConcurrency = 4;
const defaultConnectTimeoutMillis = 10_000;
const maximumDescription = 2_048;
const utf8 = new TextEncoder();
const jsonValueSchema = z.json();
const argumentsSchema = z.record(z.string(), jsonValueSchema);
const identifierPattern = /^[A-Za-z][A-Za-z0-9_]*$/u;

/** One remote MCP server a host has admitted for an Agent. */
export type McpServerConnection = Readonly<{
  /** Stable authority id for the server's module; never shown as a secret. */
  id: string;
  /** Model-facing identifier: the guest calls `env.<namespace>.<name>.<tool>()`. */
  name: string;
  /** Streamable HTTP endpoint. */
  url: URL;
  /**
   * Host-held request headers such as `Authorization`. They are sent only to
   * `url` by the SDK transport and never enter the snapshot, the catalog or a
   * tool result.
   */
  headers?: Readonly<Record<string, string>>;
}>;

/** A captured host list of remote MCP servers; authority stays with the host. */
export type McpServersConnectionOptions = Readonly<{
  id: string;
  /** Capture the current server list and a secret-free revision of it. */
  read: () => Promise<
    Readonly<{ version: string; servers: readonly McpServerConnection[] }>
  >;
  /** Register invalidation and return its release callback. */
  subscribe: (invalidate: () => void) => () => void;
  /** Receives each server dropped from an acquisition and why. */
  onUnavailable: (error: McpServerUnavailableError) => void;
  /** Host egress for every MCP request; the host chooses where requests may go. */
  fetch: FetchLike;
  /** Parent namespace for every server module; defaults to `["mcp"]`. */
  namespace?: readonly string[];
  /** Bound on connecting and listing one server; defaults to 10 seconds. */
  connectTimeoutMillis?: number;
}>;

/** Why one MCP server contributed no module to an acquisition. */
export type McpServerUnavailableReason =
  "rejected" | "unauthorized" | "timeout" | "invalid-advertisement";

/** One MCP server whose tools could not be acquired. */
export class McpServerUnavailableError extends Error {
  override readonly name = "McpServerUnavailableError";
  readonly serverId: string;
  readonly reason: McpServerUnavailableReason;

  constructor(
    serverId: string,
    reason: McpServerUnavailableReason,
    cause?: unknown,
  ) {
    super(`MCP server ${serverId} is unavailable: ${reason}`, { cause });
    this.serverId = serverId;
    this.reason = reason;
  }
}

async function digest(serialized: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", utf8.encode(serialized)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** Map an MCP tool name onto the guest's identifier grammar. */
function operationKey(toolName: string) {
  const mapped = toolName.replace(/[^A-Za-z0-9_]/gu, "_");
  return identifierPattern.test(mapped) ? mapped : `t_${mapped}`;
}

const looseDescription =
  "Arguments are a JSON object; this server's schema is outside the supported subset, so the server validates them.";

/** The tool's advertised schema when it fits Forage's subset, else a JSON object. */
function toolInput(tool: Tool) {
  const subset = jsonSchemaSubset().safeParse(tool.inputSchema);
  if (!subset.success) return { schema: argumentsSchema, loose: true };
  try {
    return {
      schema: z.fromJSONSchema(subset.data).pipe(argumentsSchema),
      loose: false,
    };
  } catch {
    return { schema: argumentsSchema, loose: true };
  }
}

function toolDescription(tool: Tool, loose: boolean) {
  const text = [tool.title, tool.description]
    .filter((part) => part !== undefined && part.length > 0)
    .join(": ");
  const base = text.length > 0 ? text : tool.name;
  const described = loose ? `${base}\n\n${looseDescription}` : base;
  return described.slice(0, maximumDescription);
}

type Connected = Readonly<{
  module: ModuleRegistration;
  version: string;
  close: () => Promise<void>;
}>;

function project(
  server: McpServerConnection,
  namespace: readonly string[],
  client: Client,
  tools: readonly Tool[],
): ModuleRegistration {
  const operations: Record<string, OperationRegistration> = {};
  for (const tool of tools) {
    const key = operationKey(tool.name);
    // A later tool that maps onto a taken key is dropped, never renamed twice.
    if (key in operations) continue;
    const input = toolInput(tool);
    operations[key] = Mycelium.operation({
      // Only the server's own read-only hint permits replay.
      replay: tool.annotations?.readOnlyHint === true ? "safe" : "unsafe",
      description: toolDescription(tool, input.loose),
      input: input.schema,
      output: jsonValueSchema,
      execute: async (args, context) => {
        const result = await client.callTool(
          { name: tool.name, arguments: args },
          { signal: context.signal },
        );
        // MCP's own result shape: structured data when the server sends it,
        // otherwise the content blocks with the error flag.
        if (result.isError !== true && result.structuredContent !== undefined)
          return jsonValueSchema.parse(result.structuredContent);
        return jsonValueSchema.parse({
          isError: result.isError === true,
          content: result.content,
        });
      },
    });
  }
  return Mycelium.module({
    id: server.id,
    name: server.name,
    namespace,
    description: `MCP server "${server.name}" at ${server.url.origin}: tools it advertises.`,
    operations,
  });
}

async function listAllTools(client: Client, signal: AbortSignal) {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maximumToolPages; page += 1) {
    const listed = await client.listTools(
      cursor === undefined ? undefined : { cursor },
      { signal },
    );
    tools.push(...listed.tools);
    if (tools.length > maximumTools)
      throw new Error(
        `MCP server advertises more than ${String(maximumTools)} tools`,
      );
    cursor = listed.nextCursor;
    if (cursor === undefined) return tools;
  }
  throw new Error(
    `MCP server tool list exceeds ${String(maximumToolPages)} pages`,
  );
}

type McpClientModule = typeof import("@modelcontextprotocol/client");

/**
 * The SDK builds its whole schema set when its module evaluates, so it loads
 * on the first connection instead of during a host Worker's startup.
 */
function loadClientModule(): Promise<McpClientModule> {
  return import("@modelcontextprotocol/client");
}

function failureReason(
  mcp: McpClientModule,
  cause: unknown,
): McpServerUnavailableReason {
  if (mcp.UnauthorizedError.isInstance(cause)) return "unauthorized";
  if (
    mcp.SdkHttpError.isInstance(cause) &&
    (cause.status === 401 || cause.status === 403)
  )
    return "unauthorized";
  return "rejected";
}

async function connect(
  server: McpServerConnection,
  namespace: readonly string[],
  fetch: FetchLike,
  signal: AbortSignal,
): Promise<Connected> {
  const mcp = await loadClientModule();
  const client = new mcp.Client({ name: "fungi-knapsack", version: "1" });
  const transport = new mcp.StreamableHTTPClientTransport(new URL(server.url), {
    // Credentials go to this endpoint only; a redirect could carry them away.
    requestInit: { headers: { ...server.headers }, redirect: "error" },
    fetch,
  });
  try {
    await client.connect(transport, { signal });
  } catch (cause) {
    await client.close();
    throw new McpServerUnavailableError(
      server.id,
      failureReason(mcp, cause),
      cause,
    );
  }
  try {
    const tools = await listAllTools(client, signal).catch((cause: unknown) => {
      throw new McpServerUnavailableError(
        server.id,
        failureReason(mcp, cause) === "unauthorized"
          ? "unauthorized"
          : "invalid-advertisement",
        cause,
      );
    });
    let module: ModuleRegistration;
    try {
      module = project(server, namespace, client, tools);
    } catch (cause) {
      throw new McpServerUnavailableError(
        server.id,
        "invalid-advertisement",
        cause,
      );
    }
    const version = await digest(
      JSON.stringify([
        server.id,
        server.name,
        server.url.href,
        tools.map((tool) => [
          tool.name,
          tool.description ?? null,
          tool.inputSchema,
          tool.annotations?.readOnlyHint ?? null,
        ]),
      ]),
    );
    return { module, version, close: () => client.close() };
  } catch (error) {
    await client.close();
    throw error;
  }
}

function connectWithin(
  server: McpServerConnection,
  namespace: readonly string[],
  fetch: FetchLike,
  timeoutMillis: number,
) {
  return Effect.tryPromise({
    try: (signal) => connect(server, namespace, fetch, signal),
    catch: (cause) =>
      cause instanceof McpServerUnavailableError
        ? cause
        : new McpServerUnavailableError(server.id, "rejected", cause),
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMillis,
      orElse: () =>
        Effect.fail(new McpServerUnavailableError(server.id, "timeout")),
    }),
  );
}

/**
 * Connect every captured MCP server concurrently with the maintained SDK
 * client over Streamable HTTP and project its tools into one Mycelium module
 * per server. A server that rejects, refuses its credential, times out or
 * advertises nothing usable is dropped and reported; the others stay
 * available. Releasing the acquisition closes every client.
 */
function mcpServers(input: McpServersConnectionOptions): CapabilitySource {
  const timeoutMillis =
    input.connectTimeoutMillis ?? defaultConnectTimeoutMillis;
  const namespace = input.namespace ?? ["mcp"];
  return {
    id: input.id,
    acquire: async (context) => {
      context.signal.throwIfAborted();
      const unsubscribe = input.subscribe(context.invalidate);
      const opened: Connected[] = [];
      const closeAll = async () => {
        await Promise.allSettled(opened.map((server) => server.close()));
      };
      try {
        const captured = await input.read();
        if (captured.servers.length > maximumServers)
          throw new Error(
            `At most ${String(maximumServers)} MCP servers per source`,
          );
        const results = await Effect.runPromise(
          Effect.forEach(
            captured.servers,
            (server) =>
              Effect.result(
                connectWithin(
                  server,
                  namespace,
                  input.fetch,
                  timeoutMillis,
                ).pipe(
                  // Record each open client at once, so an aborted
                  // acquisition still closes the ones that connected.
                  Effect.tap((connected) =>
                    Effect.sync(() => opened.push(connected)),
                  ),
                ),
              ),
            { concurrency: connectConcurrency },
          ),
          { signal: context.signal },
        );
        const versions: string[] = [captured.version];
        for (const result of results) {
          if (Result.isFailure(result)) {
            input.onUnavailable(result.failure);
            versions.push(
              `unavailable:${result.failure.serverId}:${result.failure.reason}`,
            );
            continue;
          }
          versions.push(result.success.version);
        }
        context.signal.throwIfAborted();
        return {
          snapshot: {
            version: `mcp-${await digest(JSON.stringify(versions))}`,
            modules: opened.map((server) => server.module),
          },
          release: async () => {
            unsubscribe();
            await closeAll();
          },
        };
      } catch (error) {
        unsubscribe();
        await closeAll();
        throw error;
      }
    },
  };
}

export { mcpServers };
