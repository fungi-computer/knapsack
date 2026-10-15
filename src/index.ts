import {
  Mycelium,
  type CapabilitySource,
  type InvocationContext,
  type OperationRegistration,
  type ModuleRegistration,
  type MyceliumJsonValue,
} from "@fungi.computer/mycelium";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { z } from "zod";

import { files, type FilesConnectionOptions } from "./files.js";
import { mcpServers } from "./mcp.js";

const maximumCapabilities = 256;
const describeConcurrency = 8;
const defaultDescribeTimeoutMillis = 10_000;
const utf8 = new TextEncoder();
const jsonValueSchema = z.json();
const jsonSchemaDocument = z.custom<Parameters<typeof z.fromJSONSchema>[0]>(
  (value) => jsonValueSchema.safeParse(value).success,
);
const capabilityNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/);
const capabilitySchema = z.strictObject({
  id: capabilityNameSchema,
  name: capabilityNameSchema,
  kind: z.string().min(1).max(128),
  description: z.string().min(1).max(2_048),
  parameters: jsonSchemaDocument,
  output: jsonSchemaDocument.optional(),
});
const capabilitiesSchema = z.array(capabilitySchema).max(maximumCapabilities);

type JsonSchemaDocument = Parameters<typeof z.fromJSONSchema>[0];

/** Generic advertised-call interface supplied by one Computer provider. */
export type KnapsackComputer = Readonly<{
  /** Knapsack stops waiting when `signal` aborts, whether or not the provider honours it. */
  getCapabilities: (signal: AbortSignal) => Promise<MyceliumJsonValue>;
  /** Dispatch one decoded advertised identifier with its JSON payload. */
  call: (
    capabilityId: string,
    input: MyceliumJsonValue,
    context: InvocationContext,
  ) => Promise<MyceliumJsonValue>;
}>;

/** Selection and naming required to connect one Computer to Mycelium. */
export type ComputerConnectionOptions = Readonly<{
  id: string;
  name: string;
  /** Logical parent namespace; the Computer name is its final segment. */
  namespace?: readonly string[];
  /** Files scoped by the host to this Computer, under its own authority id. */
  files?: FilesConnectionOptions;
  /**
   * Short parenthetical shown alongside the Computer's real name in forage
   * discovery, e.g. "home" for the agent's own machine. Omit for Computers
   * with no such role; never used to rename or hide the Computer itself.
   */
  role?: string;
  computer: KnapsackComputer;
}>;

function operationSchema(document: JsonSchemaDocument) {
  return z.fromJSONSchema(document).pipe(jsonValueSchema);
}

function operationOutputSchema(document: JsonSchemaDocument) {
  return z.intersection(jsonValueSchema, z.fromJSONSchema(document));
}

async function snapshotVersion(serialized: string) {
  const bytes = utf8.encode(serialized);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `computer-${Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

/** Why one Computer contributed no module to an acquisition. */
export type ComputerUnavailableReason =
  "rejected" | "timeout" | "invalid-advertisement";

/** One Computer whose advertisement could not be acquired. */
export class ComputerUnavailableError extends Error {
  override readonly name = "ComputerUnavailableError";
  readonly computerId: string;
  readonly reason: ComputerUnavailableReason;

  constructor(
    computerId: string,
    reason: ComputerUnavailableReason,
    cause?: unknown,
  ) {
    super(`Computer ${computerId} is unavailable: ${reason}`, { cause });
    this.computerId = computerId;
    this.reason = reason;
  }
}

function projectComputer(
  input: ComputerConnectionOptions,
  advertisement: MyceliumJsonValue,
) {
  const capabilities = capabilitiesSchema.parse(advertisement);
  const operations: Record<string, OperationRegistration | ModuleRegistration> =
    {};
  for (const advertised of capabilities) {
    const output =
      advertised.output === undefined
        ? jsonValueSchema
        : operationOutputSchema(advertised.output);
    operations[advertised.id] = Mycelium.operation({
      // Computer advertisements may execute arbitrary host actions.
      replay: "unsafe",
      description: advertised.description,
      input: operationSchema(advertised.parameters),
      output,
      execute: (value, context) =>
        input.computer.call(advertised.id, value, context),
    });
  }
  if (input.files !== undefined) {
    if (operations.files !== undefined)
      throw new Error("Computer advertisement reserves the files namespace");
    operations.files = files(input.files).module;
  }
  const description =
    input.role === undefined
      ? `Computer "${input.name}": capabilities advertised by this Computer.`
      : `Computer "${input.name}" (${input.role}): capabilities advertised by this Computer.`;
  const module = Mycelium.module({
    id: input.id,
    name: input.name,
    namespace: input.namespace ?? [],
    description,
    operations,
  });
  return { module, serialized: JSON.stringify(capabilities) };
}

/** Read and project one advertisement; interruption abandons a hung provider. */
function describeComputer(
  input: ComputerConnectionOptions,
  timeoutMillis: number,
) {
  return Effect.tryPromise({
    try: (signal) => input.computer.getCapabilities(signal),
    catch: (cause) => new ComputerUnavailableError(input.id, "rejected", cause),
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeoutMillis,
      orElse: () =>
        Effect.fail(new ComputerUnavailableError(input.id, "timeout")),
    }),
    Effect.flatMap((advertisement) =>
      Effect.try({
        try: () => projectComputer(input, advertisement),
        catch: (cause) =>
          new ComputerUnavailableError(
            input.id,
            "invalid-advertisement",
            cause,
          ),
      }),
    ),
    Effect.flatMap(({ module, serialized }) =>
      Effect.promise(() => snapshotVersion(serialized)).pipe(
        Effect.map((version) => ({ module, version })),
      ),
    ),
  );
}

async function runAcquisition<A>(
  effect: Effect.Effect<A>,
  signal: AbortSignal,
): Promise<A> {
  signal.throwIfAborted();
  try {
    return await Effect.runPromise(effect, { signal });
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  }
}

function computer(input: ComputerConnectionOptions): CapabilitySource {
  return {
    id: input.id,
    acquire: async ({ signal }) => {
      const described = await runAcquisition(
        Effect.result(describeComputer(input, defaultDescribeTimeoutMillis)),
        signal,
      );
      if (Result.isFailure(described)) throw described.failure;
      return {
        snapshot: {
          version: described.success.version,
          modules: [described.success.module],
        },
        release: () => Promise.resolve(),
      };
    },
  };
}

/** A captured host connection list; authority remains with its supplying host. */
export type ComputersConnectionOptions = Readonly<{
  id: string;
  /** Capture the current host-owned connection list and its revision. */
  read: () => Readonly<{
    version: string;
    connections: readonly ComputerConnectionOptions[];
  }>;
  /** Register invalidation and return its release callback. */
  subscribe: (invalidate: () => void) => () => void;
  /** Receives each Computer dropped from an acquisition and why. */
  onUnavailable: (error: ComputerUnavailableError) => void;
  /** Bound on each Computer's advertisement read; defaults to 10 seconds. */
  describeTimeoutMillis?: number;
}>;

/**
 * Acquire every captured Computer concurrently. A Computer that rejects, times
 * out, or advertises an unusable schema is dropped and reported; the remaining
 * Computers and Files stay available. Aborting the acquisition rejects it.
 */
function computers(input: ComputersConnectionOptions): CapabilitySource {
  const timeoutMillis =
    input.describeTimeoutMillis ?? defaultDescribeTimeoutMillis;
  return {
    id: input.id,
    acquire: async (context) => {
      context.signal.throwIfAborted();
      const unsubscribe = input.subscribe(context.invalidate);
      try {
        const captured = input.read();
        const described = await runAcquisition(
          Effect.forEach(
            captured.connections,
            (connection) =>
              Effect.result(describeComputer(connection, timeoutMillis)),
            { concurrency: describeConcurrency },
          ),
          context.signal,
        );
        const modules: ModuleRegistration[] = [];
        const versions: string[] = [captured.version];
        for (const result of described) {
          if (Result.isFailure(result)) {
            input.onUnavailable(result.failure);
            versions.push(
              `unavailable:${result.failure.computerId}:${result.failure.reason}`,
            );
            continue;
          }
          modules.push(result.success.module);
          versions.push(result.success.version);
        }
        return {
          snapshot: {
            version: await snapshotVersion(JSON.stringify(versions)),
            modules,
          },
          release: () => {
            unsubscribe();
            return Promise.resolve();
          },
        };
      } catch (error) {
        unsubscribe();
        throw error;
      }
    },
  };
}

/** Agent tool connections available for composition through Mycelium. */
export const Knapsack = Object.freeze({
  /** Project one Computer's advertised operations into a capability source. */
  computer,
  /** Capture a changing Computer list, reporting unavailable providers independently. */
  computers,
  /** Build Files operations from one captured host port. */
  files,
  /** Connect a changing list of remote MCP servers, reporting unavailable ones independently. */
  mcpServers,
});

export {
  McpServerUnavailableError,
  type McpServerConnection,
  type McpServerUnavailableReason,
  type McpServersConnectionOptions,
} from "./mcp.js";

export {
  FilesEditError,
  filesEditFailureSchema,
  type FilesEditErrorReason,
  type FilesConnectionOptions,
  type FilesPort,
  type FilesPatch,
  type FilesSurface,
  edit,
  readInputSchema,
  readOutputSchema,
  listInputSchema,
  listOutputSchema,
  globInputSchema,
  globOutputSchema,
  grepInputSchema,
  grepOutputSchema,
  editInputSchema,
  editOutputSchema,
  patchInputSchema,
  patchOutputSchema,
  type FileTool,
  type FileToolName,
} from "./files.js";
