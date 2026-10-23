import { directSandbox } from "@fungi.computer/mycelium/testing";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPatch, parsePatch } from "diff";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  Mycelium,
  type InvocationContext,
  type MyceliumJsonValue,
} from "@fungi.computer/mycelium";
import { readOutputSchema, sniffImageMimeType } from "../src/files-read.js";
import {
  Knapsack,
  type FilesPort,
  type FileTool,
  type FileToolName,
} from "../src/index.js";

type FilesOperation = "read" | "list" | "glob" | "grep" | "edit" | "patch";
type MemoryPort = Readonly<{ port: FilesPort; get: () => string }>;
type ExecuteResult = Readonly<{
  content: readonly [{ type: "text"; text: string }];
  isError: boolean;
}>;
const editPatchResult = z.object({
  path: z.string(),
  bytes: z.number(),
  diff: z.string(),
  firstChangedLine: z.number().nullable(),
  unifiedPatch: z.string().nullable(),
  unifiedPatchBytes: z.number(),
  unifiedPatchAddedLines: z.number(),
  unifiedPatchRemovedLines: z.number(),
  unifiedPatchTruncated: z.boolean(),
});

function memoryPort(initial: string): MemoryPort {
  let content = initial;
  return {
    port: {
      read: (input) => {
        const page = content.slice(input.offset, input.offset + input.limit);
        const nextOffset = input.offset + page.length;
        return Promise.resolve({
          path: input.path,
          content: page,
          offset: input.offset,
          nextOffset: nextOffset < content.length ? nextOffset : null,
          truncated: nextOffset < content.length,
        });
      },
      list: (input) =>
        Promise.resolve({ path: input.path, results: [], truncated: null }),
      glob: (input) =>
        Promise.resolve({ path: input.path, results: [], truncated: null }),
      grep: (input) =>
        Promise.resolve({ path: input.path, results: [], truncated: null }),
      replace: (input) => {
        if (content !== input.expectedContent)
          return Promise.reject(
            new Error(`Files edit conflict: ${input.path}`),
          );
        content = input.content;
        return Promise.resolve({
          path: input.path,
          bytes: new TextEncoder().encode(input.content).byteLength,
        });
      },
    },
    get: () => content,
  };
}

async function executeInner(
  port: FilesPort,
  operation: FilesOperation,
  argumentsValue: MyceliumJsonValue,
): Promise<ExecuteResult> {
  const { content, isError } = await executeAll(
    port,
    operation,
    argumentsValue,
  );
  const [text] = content;
  if (text?.type !== "text")
    throw new Error("Files test expected text content");
  return { content: [{ type: "text", text: text.text }], isError };
}

/** Every content part of the execute result, images included. */
async function executeAll(
  port: FilesPort,
  operation: FilesOperation,
  argumentsValue: MyceliumJsonValue,
) {
  let sandboxFailure: Error | undefined;
  const surface = Knapsack.files({ port });
  const runtime = await Mycelium.make({
    modules: [surface.module],
    sandbox: directSandbox(async (bindings) => {
      const binding = bindings.files?.[operation];
      if (binding === undefined) throw new Error("Files module is unavailable");
      try {
        return await binding(argumentsValue);
      } catch (cause) {
        const failure =
          cause instanceof Error
            ? cause
            : new Error("Files binding failed", { cause });
        sandboxFailure = failure;
        throw failure;
      }
    }),
  });
  const lease = await runtime.acquire();
  const prepared = await Effect.runPromise(
    lease.executeTool.prepare({
      type: "toolCall",
      id: "execute",
      name: "execute",
      arguments: { code: operation },
    }),
  );
  let output;
  try {
    const parts = await Effect.runPromise(
      Stream.runCollect(prepared.execute()),
    );
    const [part] = parts;
    if (part?.type !== "result")
      throw new Error("Files test expected a terminal result");
    output = { content: part.result.content, isError: part.result.isError };
  } catch (cause) {
    await lease.release();
    await runtime.close();
    if (sandboxFailure !== undefined) throw sandboxFailure;
    throw cause instanceof Error
      ? cause
      : new Error("Files execution failed", { cause });
  }
  await lease.release();
  await runtime.close();
  return output;
}

async function editFailure(
  port: FilesPort,
  input: Readonly<{ path: string; oldText: string; newText: string }>,
) {
  const result = await executeInner(port, "edit", input);
  return z
    .strictObject({
      status: z.literal("failed"),
      error: z.strictObject({
        kind: z.string(),
        path: z.string(),
        message: z.string(),
      }),
    })
    .parse(JSON.parse(result.content[0].text));
}

describe("Knapsack patch-deferred Files module", () => {
  it("executes the real read binding through the Mycelium execute door", async () => {
    const result = await executeInner(memoryPort("hello").port, "read", {
      path: "hello.txt",
    });
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: '{"path":"hello.txt","content":"hello","offset":0,"nextOffset":null,"truncated":false}',
        },
      ],
      isError: false,
    });
  });

  it("retains the captured Computer file reference through the real execute result", async () => {
    const memory = memoryPort("hello");
    const file = { computerId: "computer-a", path: "/hello.txt" };
    const port: FilesPort = {
      ...memory.port,
      read: async (input, context) => ({
        ...(await memory.port.read(input, context)),
        file,
      }),
    };
    const result = await executeInner(port, "read", {
      path: "computer://home/hello.txt",
    });
    const decoded = readOutputSchema.parse(JSON.parse(result.content[0].text));
    expect(decoded.file).toEqual(file);
    expect(decoded.path).toBe("computer://home/hello.txt");
  });

  it("forwards the Mycelium invocation context to Files operations", async () => {
    const memory = memoryPort("hello");
    const observed: {
      operation: "read" | "list" | "glob" | "grep" | "replace";
      context: InvocationContext;
    }[] = [];
    const port = {
      read: (input, context: InvocationContext) => {
        observed.push({ operation: "read", context });
        return memory.port.read(input, context);
      },
      list: (input, context) => {
        observed.push({ operation: "list", context });
        return memory.port.list(input, context);
      },
      glob: (input, context) => {
        observed.push({ operation: "glob", context });
        return memory.port.glob(input, context);
      },
      grep: (input, context) => {
        observed.push({ operation: "grep", context });
        return memory.port.grep(input, context);
      },
      replace: (input, context) => {
        observed.push({ operation: "replace", context });
        return memory.port.replace(input, context);
      },
    } satisfies FilesPort;

    await executeInner(port, "read", { path: "hello.txt" });
    await executeInner(port, "list", { path: "." });
    await executeInner(port, "glob", { path: ".", pattern: "*.txt" });
    await executeInner(port, "grep", { path: ".", pattern: "hello" });
    await executeInner(port, "edit", {
      path: "hello.txt",
      oldText: "hello",
      newText: "goodbye",
    });

    expect(observed.map(({ operation }) => operation)).toEqual([
      "read",
      "list",
      "glob",
      "grep",
      "read",
      "replace",
    ]);
    expect(
      observed.every(({ context }) =>
        /^[A-Za-z0-9_-]+$/u.test(context.executionId),
      ),
    ).toBe(true);
    expect(
      observed.every(({ context }) => context.signal instanceof AbortSignal),
    ).toBe(true);
    expect(observed.every(({ context }) => !context.signal.aborted)).toBe(true);
    expect(observed.at(-1)?.context).toBe(observed.at(-2)?.context);
  });

  it("executes the glob binding through the same execute door", async () => {
    const port = memoryPort("hello").port;
    await expect(
      executeInner(port, "glob", { path: "docs", pattern: "*.md" }),
    ).resolves.toEqual({
      content: [
        {
          type: "text",
          text: '{"path":"docs","results":[],"truncated":null}',
        },
      ],
      isError: false,
    });
  });

  it("splices a fuzzy match into the original bytes and preserves BOM/CRLF", async () => {
    const memory = memoryPort("\uFEFFprice — 10\r\n");
    const result = await executeInner(memory.port, "edit", {
      path: "hello.txt",
      oldText: "price — 10  ",
      newText: "price -- 11",
    });
    expect(result).toMatchObject({ isError: false });
    expect(memory.get()).toBe("\uFEFFprice -- 11\r\n");
    const edit = editPatchResult.parse(JSON.parse(result.content[0].text));
    expect(edit).toMatchObject({
      path: "hello.txt",
      bytes: 16,
      diff: "-1 price — 10\n+1 price -- 11",
      firstChangedLine: 1,
      unifiedPatchAddedLines: 1,
      unifiedPatchRemovedLines: 1,
      unifiedPatchTruncated: false,
    });
    expect(edit.unifiedPatch).toBeTypeOf("string");
    if (edit.unifiedPatch === null) throw new Error("expected a full patch");
    expect(parsePatch(edit.unifiedPatch)[0]).toMatchObject({
      oldFileName: "hello.txt",
      newFileName: "hello.txt",
      hunks: [{ lines: ["-price — 10", "+price -- 11"] }],
    });
    expect(edit.unifiedPatchBytes).toBe(
      Buffer.byteLength(
        createPatch("hello.txt", "price — 10\n", "price -- 11\n", "", ""),
      ),
    );
  });

  it("reports full patch size without sending an oversized native diff", async () => {
    const result = await executeInner(memoryPort("old\n").port, "edit", {
      path: "large.txt",
      oldText: "old",
      newText: "x".repeat(70_000),
    });
    const edit = editPatchResult.parse(JSON.parse(result.content[0].text));
    expect(edit.unifiedPatch).toBeNull();
    expect(edit.unifiedPatchTruncated).toBe(true);
    expect(edit.unifiedPatchBytes).toBeGreaterThan(65_536);
    expect(edit.unifiedPatchAddedLines).toBe(1);
    expect(edit.unifiedPatchRemovedLines).toBe(1);
  });

  it("changes only the fuzzy-matched span of a multi-line file", async () => {
    const before = "\uFEFF# Title  \r\nIt don’t break\n";
    const after = "ﬁle ＡＢ  \r\nprice — 12\ntrailing\u00A0\r\n";
    const memory = memoryPort(`${before}price — 10 \r${after}`);
    const result = await executeInner(memory.port, "edit", {
      path: "notes.md",
      oldText: "price - 10\n",
      newText: "price -- 11\n",
    });
    expect(memory.get()).toBe(`${before}price -- 11\r\n${after}`);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      diff: [
        " 1 # Title  ",
        " 2 It don’t break",
        "-3 price — 10 ",
        "+3 price -- 11",
        " 4 ﬁle ＡＢ  ",
        " 5 price — 12",
        " 6 trailing\u00A0",
      ].join("\n"),
      firstChangedLine: 3,
    });
  });

  it("refuses a fuzzy match that splits one original character", async () => {
    const memory = memoryPort("ﬁle\n");
    await expect(
      editFailure(memory.port, {
        path: "hello.txt",
        oldText: "ile",
        newText: "ILE",
      }),
    ).resolves.toMatchObject({
      error: { kind: "partial-character", path: "hello.txt" },
    });
    expect(memory.get()).toBe("ﬁle\n");
  });

  it("characterizes retained numbered context formatting", async () => {
    const content =
      "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";
    const middle = await executeInner(memoryPort(content).port, "edit", {
      path: "context.txt",
      oldText: "six",
      newText: "SIX",
    });
    expect(JSON.parse(middle.content[0].text)).toMatchObject({
      diff: [
        "    ...",
        "  2 two",
        "  3 three",
        "  4 four",
        "  5 five",
        "- 6 six",
        "+ 6 SIX",
        "  7 seven",
        "  8 eight",
        "  9 nine",
        " 10 ten",
      ].join("\n"),
      firstChangedLine: 6,
    });
    const leading = await executeInner(memoryPort(content).port, "edit", {
      path: "context.txt",
      oldText: "one",
      newText: "ONE",
    });
    expect(JSON.parse(leading.content[0].text)).toMatchObject({
      diff: [
        "- 1 one",
        "+ 1 ONE",
        "  2 two",
        "  3 three",
        "  4 four",
        "  5 five",
        "    ...",
      ].join("\n"),
      firstChangedLine: 1,
    });
  });

  it("refuses a truncated edit source before requesting a replacement", async () => {
    const memory = memoryPort("x");
    let replacementRequested = false;
    const port = {
      ...memory.port,
      read: (input) =>
        Promise.resolve({
          path: input.path,
          content: "x",
          offset: input.offset,
          nextOffset: 1,
          truncated: true,
        }),
      replace: async (input, context) => {
        replacementRequested = true;
        return await memory.port.replace(input, context);
      },
    } satisfies FilesPort;
    await expect(
      editFailure(port, {
        path: "hello.txt",
        oldText: "x",
        newText: "y",
      }),
    ).resolves.toMatchObject({
      error: { kind: "file-too-large", path: "hello.txt" },
    });
    expect(replacementRequested).toBe(false);
  });

  it("rejects ambiguous and missing fuzzy edit matches", async () => {
    await expect(
      editFailure(memoryPort("x\nx\n").port, {
        path: "hello.txt",
        oldText: "x",
        newText: "y",
      }),
    ).resolves.toMatchObject({
      error: { kind: "ambiguous", path: "hello.txt" },
    });
    await expect(
      editFailure(memoryPort("x\n").port, {
        path: "hello.txt",
        oldText: "missing",
        newText: "y",
      }),
    ).resolves.toMatchObject({
      error: { kind: "not-found", path: "hello.txt" },
    });
  });
});

async function directResult(
  port: FilesPort,
  name: Exclude<FileToolName, "apply_patch">,
  args: Parameters<FileTool["prepare"]>[0]["arguments"],
) {
  const tool = Knapsack.files({ port }).tools.find(
    (item) => item.descriptor.name === name,
  );
  if (tool === undefined) throw new Error(`Missing ${name} tool`);
  const prepared = await Effect.runPromise(
    tool.prepare({
      type: "toolCall",
      id: name,
      name,
      arguments: args,
    }),
  );
  const parts = await Effect.runPromise(Stream.runCollect(prepared.execute()));
  const first = parts[0];
  if (first?.type !== "result") throw new Error("Expected direct result");
  return first.result;
}

it("offers separate list, glob and grep schemas with one-line descriptions and no find tool", async () => {
  const port = memoryPort("hello").port;
  const surface = Knapsack.files({ port });
  expect(surface.tools.map((tool) => tool.descriptor.name)).toEqual([
    "read",
    "list",
    "glob",
    "grep",
  ]);
  for (const [name, properties, required] of [
    ["list", ["limit", "path"], []],
    ["glob", ["limit", "path", "pattern"], ["pattern"]],
    [
      "grep",
      ["ignoreCase", "include", "limit", "path", "pattern", "regex"],
      ["pattern"],
    ],
  ] as const) {
    const tool = surface.tools.find((entry) => entry.descriptor.name === name);
    if (tool === undefined) throw new Error(`Missing ${name} tool`);
    const parameters = z
      .object({
        type: z.literal("object"),
        additionalProperties: z.literal(false),
        required: z.array(z.string()).optional(),
        properties: z.record(z.string(), z.unknown()),
      })
      .parse(tool.descriptor.parameters);
    expect(Object.keys(parameters.properties).toSorted()).toEqual(properties);
    expect(parameters.required ?? []).toEqual(required);
    expect(tool.descriptor.description.trim()).not.toBe("");
    expect(tool.descriptor.description).not.toMatch(/[\r\n]/u);
  }
  expect(await directResult(port, "read", { path: "hello.txt" })).toEqual(
    await executeInner(port, "read", { path: "hello.txt" }),
  );
});

it("keeps apply_patch first when the Files host supplies it", () => {
  const port = {
    ...memoryPort("").port,
    patch: () =>
      Promise.resolve({
        status: "completed" as const,
        exitCode: 0,
        stdout: "",
        stderr: "",
        truncated: false as const,
      }),
  };
  expect(
    Knapsack.files({ port }).tools.map((tool) => tool.descriptor.name),
  ).toEqual(["apply_patch", "read", "list", "glob", "grep"]);
});

it("refuses the superseded hybrid search arguments through direct and execute projections", async () => {
  const port = memoryPort("").port;
  for (const [name, args] of [
    ["list", { path: ".", contains: "hello" }],
    ["glob", { path: ".", name: "*.ts" }],
    ["grep", { path: ".", contains: "hello" }],
  ] as const) {
    await expect(directResult(port, name, args)).rejects.toThrow();
    await expect(executeInner(port, name, args)).rejects.toThrow();
  }
});

it("names the shared ignore policy in every search description", () => {
  const surface = Knapsack.files({ port: memoryPort("").port });
  for (const name of ["list", "glob", "grep"]) {
    const description = surface.tools.find(
      (entry) => entry.descriptor.name === name,
    )?.descriptor.description;
    expect(description).toContain("Search skips .git and gitignored paths.");
  }
});

it("renders directory entries, glob paths and bounded grep lines with honest truncation", async () => {
  const long = "x".repeat(600);
  const port = {
    ...memoryPort("").port,
    list: () =>
      Promise.resolve({
        path: ".",
        results: [
          { path: "src", type: "directory" as const },
          { path: "src/a.ts", type: "file" as const },
        ],
        truncated: "limit" as const,
      }),
    glob: () =>
      Promise.resolve({
        path: ".",
        results: [{ path: "src/a.ts", type: "file" as const }],
        truncated: null,
      }),
    grep: () =>
      Promise.resolve({
        path: ".",
        results: [{ path: "src/a.ts", line: 3, text: long }],
        truncated: "limit" as const,
      }),
  };
  const result = await directResult(port, "list", { path: "." });
  expect(result.content).toEqual([
    {
      type: "text",
      text: [
        "src/",
        "src/a.ts",
        "[truncated: result limit reached; raise limit or narrow path]",
      ].join("\n"),
    },
  ]);
  expect(await directResult(port, "glob", { pattern: "*.ts" })).toEqual({
    content: [{ type: "text", text: "src/a.ts" }],
    isError: false,
  });
  expect(await directResult(port, "grep", { pattern: "x" })).toEqual({
    content: [
      {
        type: "text",
        text: `src/a.ts:3: ${"x".repeat(500)}…\n[truncated: result limit reached; raise limit or narrow path]`,
      },
    ],
    isError: false,
  });
  const scanned = await directResult(
    {
      ...port,
      grep: () =>
        Promise.resolve({ path: ".", results: [], truncated: "scan" as const }),
    },
    "grep",
    { path: ".", pattern: "x" },
  );
  expect(scanned.content).toEqual([
    {
      type: "text",
      text: "[truncated: scan limit reached before the search finished; narrow path]",
    },
  ]);
});

it("labels every Files operation and direct tool so a read grant keeps reads and refuses writes", async () => {
  const memory = memoryPort("hello");
  const port = {
    ...memory.port,
    patch: () =>
      Promise.resolve({
        status: "completed" as const,
        exitCode: 0,
        stdout: "",
        stderr: "",
        truncated: false as const,
      }),
  };
  const surface = Knapsack.files({ port });
  expect(
    surface.tools.map(({ descriptor, module, access }) => [
      descriptor.name,
      module,
      access,
    ]),
  ).toEqual([
    ["apply_patch", "files", "write"],
    ["read", "files", "read"],
    ["list", "files", "read"],
    ["glob", "files", "read"],
    ["grep", "files", "read"],
  ]);
  const results = new Map<string, MyceliumJsonValue>();
  const runtime = await Mycelium.make({
    modules: [surface.module],
    access: { grants: { files: "read" } },
    sandbox: directSandbox(async (bindings) => {
      const files = bindings.files;
      if (files === undefined) throw new Error("files missing");
      for (const [name, input] of [
        ["read", { path: "a", offset: 0, limit: 10 }],
        ["list", { path: "." }],
        ["glob", { path: ".", pattern: "*.txt" }],
        ["grep", { path: ".", pattern: "h" }],
        ["edit", { path: "a", oldText: "hello", newText: "bye" }],
        ["patch", { patch: "" }],
      ] as const) {
        const bound = files[name];
        if (bound === undefined) throw new Error(`${name} missing`);
        results.set(name, await bound(input));
      }
      return null;
    }),
  });
  const lease = await runtime.acquire();
  try {
    const prepared = await Effect.runPromise(
      lease.executeTool.prepare({
        type: "toolCall",
        id: "labels",
        name: "execute",
        arguments: { code: "" },
      }),
    );
    await Effect.runPromise(Stream.runCollect(prepared.execute()));
  } finally {
    await lease.release();
    await runtime.close();
  }
  for (const name of ["read", "list", "glob", "grep"])
    expect(results.get(name)).not.toMatchObject({ refused: true });
  for (const name of ["edit", "patch"])
    expect(results.get(name)).toMatchObject({
      refused: true,
      module: "files",
      reason: "read-only",
    });
  expect(memory.get()).toBe("hello");
});

it("awaits Files cancellation acknowledgement before direct tool teardown completes", async () => {
  const started = Promise.withResolvers<undefined>();
  const aborted = Promise.withResolvers<undefined>();
  const cleanup = Promise.withResolvers<undefined>();
  let cleaned = false;
  const surface = Knapsack.files({
    port: {
      ...memoryPort("").port,
      patch: async (_input, context) => {
        context.signal.addEventListener(
          "abort",
          () => {
            aborted.resolve(undefined);
          },
          {
            once: true,
          },
        );
        started.resolve(undefined);
        await cleanup.promise;
        cleaned = true;
        return {
          status: "cancelled",
          exitCode: -1,
          stdout: "",
          stderr: "cancelled",
          truncated: false,
        };
      },
    },
  });
  const tool = surface.tools[0];
  if (tool === undefined) throw new Error("Patch tool missing");
  const prepared = await Effect.runPromise(
    tool.prepare({
      type: "toolCall",
      id: "held-patch",
      name: "apply_patch",
      arguments: { patch: "*** Begin Patch\n*** End Patch" },
    }),
  );
  const running = Effect.runFork(Stream.runDrain(prepared.execute()));
  await started.promise;
  let interrupted = false;
  const stopping = Effect.runPromise(Fiber.interrupt(running)).then(() => {
    interrupted = true;
  });
  await aborted.promise;
  expect(interrupted).toBe(false);
  cleanup.resolve(undefined);
  await stopping;
  expect(cleaned).toBe(true);
});

it("presents apply_patch parameters from the same Zod decoder as files.patch", async () => {
  const patch: FilesPort["patch"] = () =>
    Promise.resolve({
      status: "completed",
      exitCode: 0,
      stdout: "",
      stderr: "",
      truncated: false,
    });
  const port = { ...memoryPort("").port, patch };
  const { tools } = Knapsack.files({ port });
  expect(tools.map(({ descriptor }) => descriptor.name).sort()).toEqual([
    "apply_patch",
    "glob",
    "grep",
    "list",
    "read",
  ]);
  for (const fileTool of tools)
    expect(fileTool.descriptor.parameters).not.toHaveProperty("$schema");
  const [tool] = tools;
  if (tool === undefined) throw new Error("Patch tool missing");
  expect(tool.descriptor.parameters).toEqual({
    type: "object",
    properties: {
      patch: {
        type: "string",
        minLength: 1,
        description: "Codex patch text, at most 131072 UTF-8 bytes.",
      },
    },
    required: ["patch"],
    additionalProperties: false,
  });
  // Fits every character-count bound yet exceeds the byte bound.
  const oversized = { patch: "界".repeat(50_000) };
  const direct = await Effect.runPromise(
    Effect.flip(
      tool.prepare({
        type: "toolCall",
        id: "oversized",
        name: "apply_patch",
        arguments: oversized,
      }),
    ),
  );
  const bound = "Text exceeds the 131072-byte Files bound";
  expect(direct.message).toContain(bound);
  await expect(executeInner(port, "patch", oversized)).rejects.toThrow(bound);
});

it("returns an image read as an image part the model can look at, with the cap in the description", async () => {
  const memory = memoryPort("hello");
  const port: FilesPort = {
    ...memory.port,
    read: (input) =>
      Promise.resolve({
        path: input.path,
        image: { mimeType: "image/png", data: "iVBORw==", bytes: 4 },
      }),
  };
  const result = await directResult(port, "read", { path: "shot.png" });
  expect(result.isError).toBe(false);
  expect(result.content).toEqual([
    {
      type: "text",
      text: '{"path":"shot.png","mimeType":"image/png","bytes":4}',
    },
    { type: "image", data: "iVBORw==", mimeType: "image/png" },
  ]);
  const read = Knapsack.files({ port }).tools.find(
    (tool) => tool.descriptor.name === "read",
  );
  expect(read?.descriptor.description).toContain("512 KiB");
});

it("refuses to edit an image with a typed not-text failure", async () => {
  const memory = memoryPort("hello");
  const port: FilesPort = {
    ...memory.port,
    read: (input) =>
      Promise.resolve({
        path: input.path,
        image: { mimeType: "image/png", data: "iVBORw==", bytes: 4 },
      }),
  };
  expect(
    await editFailure(port, { path: "shot.png", oldText: "a", newText: "b" }),
  ).toMatchObject({ error: { kind: "not-text", path: "shot.png" } });
});

const pngBytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function imagePort(): FilesPort {
  return {
    ...memoryPort("hello").port,
    read: (input) =>
      Promise.resolve({
        path: input.path,
        image: { mimeType: "image/png", data: "iVBORw==", bytes: 4 },
      }),
  };
}

it("shows an image read inside execute through the image collector, never as base64 in the value", async () => {
  const { content, isError } = await executeAll(imagePort(), "read", {
    path: "shot.png",
  });
  expect(isError).toBe(false);
  expect(content).toHaveLength(2);
  const [text, image] = content;
  expect(text).toEqual({
    type: "text",
    text: '{"path":"shot.png","image":{"ref":"img_0","mimeType":"image/png","bytes":4}}',
  });
  expect(image).toEqual({
    type: "image",
    data: "iVBORw==",
    mimeType: "image/png",
  });
});

it("recognises only full image signatures", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  expect(sniffImageMimeType(Uint8Array.from(pngBytes))).toBe("image/png");
  expect(sniffImageMimeType(bytes("GIF89a\u0001\u0000"))).toBe("image/gif");
  expect(sniffImageMimeType(bytes("GIF87a\u0001\u0000"))).toBe("image/gif");
  expect(sniffImageMimeType(bytes("GIF8 is a text file"))).toBeUndefined();
  expect(sniffImageMimeType(bytes("\u0089PNG is text"))).toBeUndefined();
  expect(
    sniffImageMimeType(bytes("RIFF\u0004\u0000\u0000\u0000WEBPVP8 ")),
  ).toBe("image/webp");
});

it("stops showing images from the direct read tool after the per-run limit", async () => {
  const read = Knapsack.files({ port: imagePort() }).tools.find(
    (tool) => tool.descriptor.name === "read",
  );
  if (read === undefined) throw new Error("Missing read tool");
  const results = [];
  for (let index = 0; index < 9; index += 1) {
    const prepared = await Effect.runPromise(
      read.prepare({
        type: "toolCall",
        id: `read-${String(index)}`,
        name: "read",
        arguments: { path: "shot.png" },
      }),
    );
    const [part] = await Effect.runPromise(
      Stream.runCollect(prepared.execute()),
    );
    if (part?.type !== "result") throw new Error("Expected result");
    results.push(part.result);
  }
  expect(results.slice(0, 8).every(({ isError }) => !isError)).toBe(true);
  expect(results[8]?.isError).toBe(true);
  expect(JSON.stringify(results[8])).toContain("Image limit reached");
});
