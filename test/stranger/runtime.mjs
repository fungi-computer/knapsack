import { directSandbox } from "@fungi.computer/mycelium/testing";
import assert from "node:assert/strict";
import { Knapsack, readInputSchema } from "@fungi.computer/knapsack";
import { patchInputSchema } from "@fungi.computer/knapsack/files-patch";
import {
  boundedTextSchema,
  maximumReadBytes,
  pathSchema,
  readOutputSchema,
} from "@fungi.computer/knapsack/files-read";
import { parseCodexPatch } from "@fungi.computer/knapsack/patch";
import {
  createFilesReadAdapter,
  encodeFilesReadRequest,
} from "@fungi.computer/knapsack/files-read-codec";
import { Mycelium } from "@fungi.computer/mycelium";

const context = {
  executionId: "stranger-read",
  deadlineAt: null,
  signal: new globalThis.AbortController().signal,
};
const source = Knapsack.computer({
  id: "stranger-computer",
  name: "computer",
  computer: {
    getCapabilities: () =>
      Promise.resolve([
        {
          id: "echo",
          name: "echo",
          kind: "test",
          description: "Echo a string.",
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
          output: { type: "string" },
        },
      ]),
    call: (_capabilityId, input) => Promise.resolve(input.value),
  },
});
const runtime = await Mycelium.make({
  sources: [source],
  sandbox: directSandbox(() => Promise.resolve(null)),
});
try {
  const lease = await runtime.acquire();
  try {
    assert.match(
      lease.catalog.describe({ path: "computer.echo" }).types,
      /value: string/,
    );
  } finally {
    await lease.release();
  }
} finally {
  await runtime.close();
}
const request = { path: "notes.md", offset: 0, limit: 4 };
const page = {
  path: "notes.md",
  content: "hello",
  offset: 0,
  nextOffset: null,
  truncated: false,
};
const adapter = createFilesReadAdapter((frame) => {
  assert.equal(frame, encodeFilesReadRequest(request));
  return Promise.resolve(JSON.stringify({ status: "ok", result: page }));
});
assert.deepEqual(await adapter.read(request, context), page);
assert.deepEqual(readInputSchema.parse(request), request);
assert.deepEqual(readOutputSchema.parse(page), page);
assert.equal(pathSchema.parse(request.path), request.path);
assert.equal(boundedTextSchema().parse(page.content), page.content);
assert.equal(maximumReadBytes, 131_072);
assert.equal(
  boundedTextSchema().safeParse("a".repeat(maximumReadBytes + 1)).success,
  false,
);
assert.equal(
  readInputSchema.safeParse({ ...request, offset: -1 }).success,
  false,
);
const patch = "*** Begin Patch\n*** Add File: notes.md\n+hello\n*** End Patch";
assert.deepEqual(patchInputSchema.parse({ patch }), { patch });
assert.equal(parseCodexPatch(patch)[0]?.path, "notes.md");
