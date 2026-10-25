import { directSandbox } from "@fungi.computer/mycelium/testing";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";

import {
  BadResponse,
  InvalidOperationOutput,
  Mycelium,
  sandboxFailureMessage,
  type InvocationContext,
  type ModuleRegistration,
  type MyceliumJsonValue,
  type SandboxFailureEvent,
} from "@fungi.computer/mycelium";
import {
  ComputerUnavailableError,
  Knapsack,
  type FilesPort,
  type KnapsackComputer,
} from "../src/index.js";

type Equal<Left, Right> =
  (<Value>(value: Value) => Value extends Left ? 1 : 2) extends <Value>(
    value: Value,
  ) => Value extends Right ? 1 : 2
    ? true
    : false;
type Assert<Value extends true> = Value;
type KnapsackJsonContract = [
  Assert<
    Equal<
      Awaited<ReturnType<KnapsackComputer["getCapabilities"]>>,
      MyceliumJsonValue
    >
  >,
  Assert<Equal<Parameters<KnapsackComputer["call"]>[0], string>>,
  Assert<Equal<Parameters<KnapsackComputer["call"]>[1], MyceliumJsonValue>>,
  Assert<
    Equal<Awaited<ReturnType<KnapsackComputer["call"]>>, MyceliumJsonValue>
  >,
];
const knapsackJsonContract: KnapsackJsonContract = [true, true, true, true];
void knapsackJsonContract;

const parameters = z
  .json()
  .parse(
    structuredClone(z.toJSONSchema(z.strictObject({ value: z.string() }))),
  );
const output = z
  .json()
  .parse(
    structuredClone(z.toJSONSchema(z.strictObject({ value: z.string() }))),
  );
/** A JSON Schema Zod cannot convert: an unresolved reference. */
const unconvertibleSchema = { $ref: "#/$defs/missing" };
const advertisement = [
  {
    id: "echo",
    name: "echo",
    kind: "test",
    description: "Echo one value.",
    parameters,
    output,
  },
];

const filesPort: FilesPort = {
  read: ({ path, offset }) =>
    Promise.resolve({
      path,
      content: "",
      offset,
      nextOffset: null,
      truncated: false,
    }),
  list: ({ path }) => Promise.resolve({ path, results: [], truncated: null }),
  glob: ({ path }) => Promise.resolve({ path, results: [], truncated: null }),
  grep: ({ path }) => Promise.resolve({ path, results: [], truncated: null }),
  replace: ({ path, content }) =>
    Promise.resolve({ path, bytes: content.length }),
};

/** Each listed operation is backed by a contributed Computer module. */
async function expectOnlyOperations(
  modules: readonly ModuleRegistration[],
  paths: readonly string[],
) {
  expect(modules).toHaveLength(
    new Set(paths.map((path) => path.split(".")[0])).size,
  );
  const runtime = await Mycelium.make({
    modules,
    sandbox: directSandbox(() => Promise.resolve(null)),
  });
  const lease = await runtime.acquire();
  try {
    for (const path of paths)
      expect(lease.catalog.describe({ path }).types).toContain("export type");
  } finally {
    await lease.release();
    await runtime.close();
  }
}

const echoCall: KnapsackComputer["call"] = (_id, input) =>
  Promise.resolve(input);

function healthy(id: string) {
  return {
    id,
    name: id,
    computer: {
      getCapabilities: () => Promise.resolve(advertisement),
      call: echoCall,
    } satisfies KnapsackComputer,
  };
}

function hanging(id: string, observed: AbortSignal[]) {
  return {
    id,
    name: id,
    computer: {
      getCapabilities: (signal: AbortSignal) => {
        observed.push(signal);
        return new Promise<never>(() => undefined);
      },
      call: echoCall,
    } satisfies KnapsackComputer,
  };
}

describe("Knapsack Computer acquisition isolation", () => {
  it("drops a rejecting or unconvertible Computer and keeps healthy tools and Files", async () => {
    const reported: ComputerUnavailableError[] = [];
    const source = Knapsack.computers({
      id: "attached-computers",
      subscribe: () => () => undefined,
      onUnavailable: (error) => reported.push(error),
      read: () => ({
        version: "1",
        connections: [
          {
            id: "offline",
            name: "offline",
            computer: {
              getCapabilities: () => Promise.reject(new Error("detached")),
              call: (_id, input) => Promise.resolve(input),
            },
          },
          {
            id: "odd",
            name: "odd",
            computer: {
              getCapabilities: () =>
                Promise.resolve([
                  {
                    ...advertisement[0],
                    parameters: unconvertibleSchema,
                  },
                ]),
              call: (_id, input) => Promise.resolve(input),
            },
          },
          { ...healthy("cedar"), files: { port: filesPort } },
        ],
      }),
    });
    const acquired = await source.acquire({
      signal: new AbortController().signal,
      invalidate: () => undefined,
    });
    await expectOnlyOperations(acquired.snapshot.modules, [
      "cedar.echo",
      "cedar.files.read",
    ]);
    expect(
      reported.map(({ computerId, reason }) => ({ computerId, reason })),
    ).toEqual([
      { computerId: "offline", reason: "rejected" },
      { computerId: "odd", reason: "invalid-advertisement" },
    ]);
    await acquired.release();
  });

  it("drops a hung Computer at its timeout and aborts its read", async () => {
    const observed: AbortSignal[] = [];
    const reported: ComputerUnavailableError[] = [];
    const source = Knapsack.computers({
      id: "attached-computers",
      subscribe: () => () => undefined,
      onUnavailable: (error) => reported.push(error),
      describeTimeoutMillis: 20,
      read: () => ({
        version: "1",
        connections: [hanging("wedged", observed), healthy("cedar")],
      }),
    });
    const acquired = await source.acquire({
      signal: new AbortController().signal,
      invalidate: () => undefined,
    });
    await expectOnlyOperations(acquired.snapshot.modules, ["cedar.echo"]);
    expect(reported).toMatchObject([
      { computerId: "wedged", reason: "timeout" },
    ]);
    expect(observed[0]?.aborted).toBe(true);
    await acquired.release();
  });

  it("reads Computers concurrently and rejects promptly when acquisition aborts", async () => {
    const observed: AbortSignal[] = [];
    let subscribed = 0;
    const source = Knapsack.computers({
      id: "attached-computers",
      subscribe: () => {
        subscribed += 1;
        return () => {
          subscribed -= 1;
        };
      },
      onUnavailable: (error) => {
        throw error;
      },
      read: () => ({
        version: "1",
        connections: [hanging("first", observed), hanging("second", observed)],
      }),
    });
    const controller = new AbortController();
    const acquiring = source.acquire({
      signal: controller.signal,
      invalidate: () => undefined,
    });
    await vi.waitFor(() => {
      expect(observed).toHaveLength(2);
    });
    const reason = new Error("run cancelled");
    controller.abort(reason);
    await expect(acquiring).rejects.toBe(reason);
    expect(observed.every((signal) => signal.aborted)).toBe(true);
    expect(subscribed).toBe(0);
  });
});

describe("Knapsack Computer connection", () => {
  it("lets Mycelium replace a captured Computer list and release its subscriptions", async () => {
    const listeners = new Set<() => void>();
    let selected = ["first", "second"];
    const reads: string[] = [];
    const runtime = await Mycelium.make({
      sources: [
        Knapsack.computers({
          id: "attached-computers",
          subscribe: (invalidate) => {
            listeners.add(invalidate);
            return () => {
              listeners.delete(invalidate);
            };
          },
          onUnavailable: (error) => {
            throw error;
          },
          read: () => ({
            version: selected.join(","),
            connections: selected.map((id) => ({
              id,
              name: id,
              files: { port: filesPort },
              computer: {
                getCapabilities: () => {
                  reads.push(id);
                  return Promise.resolve(advertisement);
                },
                call: (_capabilityId, input) => Promise.resolve(input),
              },
            })),
          }),
        }),
      ],
      sandbox: directSandbox(() => Promise.resolve(null)),
    });
    const first = await runtime.acquire();
    expect(reads).toEqual(["first", "second"]);
    expect(
      first.catalog.describe({ path: "first.files.read" }).types,
    ).toContain("path");
    selected = ["second"];
    for (const invalidate of listeners) invalidate();
    const next = await runtime.acquire();
    expect(next.revision).not.toBe(first.revision);
    expect(reads).toEqual(["first", "second", "second"]);
    await first.release();
    await next.release();
    await runtime.close();
    expect(listeners.size).toBe(0);
  });

  it("changes the captured source version when advertised tools change without an attachment change", async () => {
    let advertised = advertisement;
    const source = Knapsack.computers({
      id: "attached-computers",
      subscribe: () => () => undefined,
      onUnavailable: (error) => {
        throw error;
      },
      read: () => ({
        version: "unchanged-attachments",
        connections: [
          {
            id: "cedar",
            name: "cedar",
            computer: {
              getCapabilities: () => Promise.resolve(advertised),
              call: (_id, input) => Promise.resolve(input),
            },
          },
        ],
      }),
    });
    const context = {
      signal: new AbortController().signal,
      invalidate: () => undefined,
    };
    const first = await source.acquire(context);
    const unchanged = await source.acquire(context);
    expect(unchanged.snapshot.version).toBe(first.snapshot.version);
    advertised = [];
    const removed = await source.acquire(context);
    expect(removed.snapshot.version).not.toBe(first.snapshot.version);
    await first.release();
    await unchanged.release();
    await removed.release();
  });

  it("projects a parsed Computer advertisement as one stable source", async () => {
    let capabilityReads = 0;
    const computer: KnapsackComputer = {
      getCapabilities: () => {
        capabilityReads += 1;
        return Promise.resolve(advertisement);
      },
      call: (_capabilityId, input) => Promise.resolve(input),
    };
    const source = Knapsack.computer({
      id: "home-computer",
      name: "computer",
      computer,
    });
    const context = {
      signal: new AbortController().signal,
      invalidate: () => undefined,
    };
    const first = await source.acquire(context);
    const second = await source.acquire(context);

    expect(source.id).toBe("home-computer");
    expect(first.snapshot.modules).toHaveLength(1);
    expect(second.snapshot.version).toBe(first.snapshot.version);
    expect(first.snapshot.version).toMatch(/^computer-[a-f0-9]{64}$/u);
    expect(capabilityReads).toBe(2);
    await first.release();
    await second.release();
  });

  it("asks before host-confirmed Computer calls without changing other connections", async () => {
    const calls: string[] = [];
    const approvals: string[] = [];
    for (const confirmCalls of [true, false]) {
      const results: unknown[] = [];
      const runtime = await Mycelium.make({
        sources: [
          Knapsack.computer({
            id: "home-computer",
            name: "computer",
            confirmCalls,
            computer: {
              getCapabilities: () => Promise.resolve(advertisement),
              call: (operation, input) => {
                calls.push(operation);
                return Promise.resolve(input);
              },
            },
          }),
        ],
        access: {
          confirm: (request) => {
            approvals.push(request.operation);
            return Promise.resolve(false);
          },
        },
        sandbox: directSandbox(async (bindings) => {
          const echo = bindings.computer?.echo;
          if (echo === undefined)
            throw new Error("Computer echo is unavailable");
          results.push(await echo({ value: "protected" }));
          return null;
        }),
      });
      const lease = await runtime.acquire();
      try {
        const prepared = await Effect.runPromise(
          lease.executeTool.prepare({
            type: "toolCall",
            id: "confirmation",
            name: "execute",
            arguments: { code: "return computer.echo({ value: 'protected' })" },
          }),
        );
        await Effect.runPromise(Stream.runDrain(prepared.execute()));
        expect(results).toEqual(
          confirmCalls
            ? [
                expect.objectContaining({
                  refused: true,
                  reason: "declined",
                }),
              ]
            : [{ value: "protected" }],
        );
      } finally {
        await lease.release();
        await runtime.close();
      }
    }
    expect(approvals).toEqual(["echo"]);
    expect(calls).toEqual(["echo"]);
  });

  it("forwards the Mycelium invocation context to Computer calls", async () => {
    expectTypeOf<
      Parameters<KnapsackComputer["call"]>[0]
    >().toEqualTypeOf<string>();
    const identifiers: string[] = [];
    const contexts: InvocationContext[] = [];
    const runtime = await Mycelium.make({
      sources: [
        Knapsack.computer({
          id: "home-computer",
          name: "computer",
          computer: {
            getCapabilities: () => Promise.resolve(advertisement),
            call: (capabilityId: string, input, context: InvocationContext) => {
              identifiers.push(capabilityId);
              contexts.push(context);
              return Promise.resolve(input);
            },
          },
        }),
      ],
      sandbox: directSandbox(async (bindings) => {
        const echo = bindings.computer?.echo;
        if (echo === undefined) throw new Error("Computer echo is unavailable");
        return await echo({ value: "context" });
      }),
    });
    const lease = await runtime.acquire();

    try {
      expect(lease.catalog.describe({ path: "computer.echo" }).types)
        .toBe(`export type computer$echo_Input = {
  value: string;
};
export type computer$echo_Output = (string | number | boolean | null | unknown[] | Record<string, unknown>) & {
    value: string;
  };
export declare const env: { ["computer"]: { ["echo"]: (input: computer$echo_Input) => Promise<computer$echo_Output> } };`);

      const prepared = await Effect.runPromise(
        lease.executeTool.prepare({
          type: "toolCall",
          id: "context",
          name: "execute",
          arguments: { code: "return computer.echo({ value: 'context' })" },
        }),
      );
      await Effect.runPromise(Stream.runDrain(prepared.execute()));

      expect(identifiers).toEqual(["echo"]);
      expect(contexts).toHaveLength(1);
      expect(contexts[0]?.executionId).toMatch(/^[A-Za-z0-9_-]+$/u);
      expect(contexts[0]?.signal).toBeInstanceOf(AbortSignal);
      expect(contexts[0]?.signal.aborted).toBe(false);
    } finally {
      await lease.release();
      await runtime.close();
    }
  });

  it.each([{ id: null }, { id: 7 }, { id: ["echo"] }])(
    "rejects a nonstring advertised id %j before calling its provider",
    async ({ id }) => {
      const call = vi.fn<KnapsackComputer["call"]>(echoCall);
      const source = Knapsack.computer({
        id: "malformed-id",
        name: "computer",
        computer: {
          getCapabilities: () => Promise.resolve([{ ...advertisement[0], id }]),
          call,
        },
      });
      await expect(
        source.acquire({
          signal: new AbortController().signal,
          invalidate: () => undefined,
        }),
      ).rejects.toMatchObject({
        computerId: "malformed-id",
        reason: "invalid-advertisement",
      });
      expect(call).not.toHaveBeenCalled();
    },
  );

  it("rejects a malformed provider advertisement", async () => {
    const source = Knapsack.computer({
      id: "broken-computer",
      name: "computer",
      computer: {
        getCapabilities: () =>
          Promise.resolve([
            {
              id: "not-a-javascript-name",
              name: "not-a-javascript-name",
              kind: "test",
              description: "Malformed",
              parameters,
            },
          ]),
        call: (_capabilityId, input) => Promise.resolve(input),
      },
    });

    const acquiring = source.acquire({
      signal: new AbortController().signal,
      invalidate: () => undefined,
    });
    await expect(acquiring).rejects.toBeInstanceOf(ComputerUnavailableError);
    await expect(acquiring).rejects.toMatchObject({
      computerId: "broken-computer",
      reason: "invalid-advertisement",
    });
    await expect(acquiring).rejects.toHaveProperty(
      ["cause", "name"],
      "ZodError",
    );
  });

  it("leaves malformed Computer results for Mycelium's output decoder", async () => {
    let bindingFailure: unknown;
    const failures: SandboxFailureEvent[] = [];
    const call = vi.fn<KnapsackComputer["call"]>(() =>
      Promise.resolve({ value: 42 }),
    );
    const runtime = await Mycelium.make({
      onSandboxFailure: (event) => {
        failures.push(event);
        return Promise.resolve();
      },
      sources: [
        Knapsack.computer({
          id: "home-computer",
          name: "computer",
          computer: {
            getCapabilities: () => Promise.resolve(advertisement),
            call,
          },
        }),
      ],
      sandbox: directSandbox(async (bindings) => {
        const echo = bindings.computer?.echo;
        if (echo === undefined) throw new Error("Computer echo is unavailable");
        try {
          return await echo({ value: "valid input" });
        } catch (cause) {
          bindingFailure = cause;
          throw cause;
        }
      }),
    });
    const lease = await runtime.acquire();

    try {
      const prepared = await Effect.runPromise(
        lease.executeTool.prepare({
          type: "toolCall",
          id: "malformed-result",
          name: "execute",
          arguments: { code: "return computer.echo({ value: 'valid input' })" },
        }),
      );
      await expect(
        Effect.runPromise(Stream.runDrain(prepared.execute())),
      ).rejects.toThrow("The sandbox returned an unreadable result");
      expect(call).toHaveBeenCalledOnce();
      expect(call.mock.calls[0]?.slice(0, 2)).toEqual([
        "echo",
        { value: "valid input" },
      ]);
      expect(call.mock.calls[0]?.[2].executionId).toMatch(/^[A-Za-z0-9_-]+$/u);
      expect(bindingFailure).toBeInstanceOf(BadResponse);
      expect(bindingFailure).toMatchObject({
        _tag: "BadResponse",
        reason: "Capability output failed its declared schema",
      });
      const decodedFailure = z.instanceof(BadResponse).parse(bindingFailure);
      expect(decodedFailure.rawCause).toBeInstanceOf(InvalidOperationOutput);
      expect(bindingFailure).toMatchObject({
        rawCause: {
          issues: [
            { code: "invalid_type", expected: "string", path: ["value"] },
          ],
        },
      });
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        tag: "BadResponse",
        fields: {
          reason: "Capability output failed its declared schema",
          rawCause: { name: "InvalidOperationOutput" },
        },
        healthAlert: false,
      });
      expect(failures[0]).toHaveProperty(
        ["fields", "rawCause", "stack"],
        expect.any(String),
      );
      expect(sandboxFailureMessage(decodedFailure)).not.toContain(
        "Invalid operation input",
      );
      expect(sandboxFailureMessage(decodedFailure)).not.toContain(
        "declared schema",
      );
    } finally {
      await lease.release();
      await runtime.close();
    }
  });
});

describe("per-Computer Files", () => {
  it("captures Files beneath their Computer authority and drops an unavailable Computer’s Files", async () => {
    const reported: ComputerUnavailableError[] = [];
    const readB = vi.fn(filesPort.read);
    const source = Knapsack.computers({
      id: "attached-computers",
      subscribe: () => () => undefined,
      onUnavailable: (error) => reported.push(error),
      read: () => ({
        version: "1",
        connections: [
          {
            ...healthy("b"),
            namespace: ["computers"],
            files: { port: { ...filesPort, read: readB } },
          },
          {
            id: "detached",
            name: "detached",
            namespace: ["computers"],
            files: { port: filesPort },
            computer: {
              getCapabilities: () => Promise.reject(new Error("detached")),
              call: echoCall,
            },
          },
        ],
      }),
    });
    const runtime = await Mycelium.make({
      sources: [source],
      sandbox: {
        execute: async (request) => {
          expect(request.modules?.b).toBe("b");
          expect(request.namespacePaths?.b).toEqual(["computers", "b"]);
          expect(request.bindings.files).toBeUndefined();
          expect(request.bindings.detached).toBeUndefined();
          const read = request.bindings.b?.["files.read"];
          if (read === undefined) throw new Error("Missing Computer Files");
          return await read({ path: "/x" });
        },
      },
    });
    const lease = await runtime.acquire();
    try {
      expect(
        lease.catalog.describe({ path: "computers.b.files.read" }).types,
      ).toContain("read");
      const prepared = await Effect.runPromise(
        lease.executeTool.prepare({
          type: "toolCall",
          id: "read-b",
          name: "execute",
          arguments: { code: "return null" },
        }),
      );
      await Effect.runPromise(Stream.runCollect(prepared.execute()));
      expect(readB).toHaveBeenCalledOnce();
      expect(reported).toMatchObject([
        { computerId: "detached", reason: "rejected" },
      ]);
    } finally {
      await lease.release();
      await runtime.close();
    }
  });

  it("refuses an advertisement that collides with the scoped Files namespace", async () => {
    const source = Knapsack.computer({
      ...healthy("b"),
      files: { port: filesPort },
      computer: {
        getCapabilities: () =>
          Promise.resolve([{ ...advertisement[0], id: "files" }]),
        call: echoCall,
      },
    });
    await expect(
      source.acquire({
        signal: new AbortController().signal,
        invalidate: () => undefined,
      }),
    ).rejects.toMatchObject({ reason: "invalid-advertisement" });
  });
});
