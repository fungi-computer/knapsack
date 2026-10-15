import {
  Knapsack,
  type KnapsackComputer,
  type ComputerConnectionOptions,
} from "@fungi.computer/knapsack";
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
import type { CapabilitySource } from "@fungi.computer/mycelium";

const computer: KnapsackComputer = {
  getCapabilities: () => Promise.resolve([]),
  call: (_capabilityId, input) => Promise.resolve(input),
};
const options: ComputerConnectionOptions = {
  id: "stranger",
  name: "computer",
  computer,
};
const source: CapabilitySource = Knapsack.computer(options);
void source;
void Knapsack.computers({
  id: "computers",
  read: () => ({ version: "1", connections: [options] }),
  subscribe: () => () => undefined,
  onUnavailable: () => undefined,
});
void patchInputSchema.parse({ patch: "*** Begin Patch\n*** End Patch" });
void pathSchema.parse("notes.md");
void boundedTextSchema().parse("hello");
void maximumReadBytes;
void readOutputSchema.parse({
  path: "notes.md",
  content: "hello",
  offset: 0,
  nextOffset: null,
  truncated: false,
});
void parseCodexPatch("*** Begin Patch\n*** End Patch");
void encodeFilesReadRequest({ path: "notes.md", offset: 0, limit: 4 });
void createFilesReadAdapter(() =>
  Promise.resolve(JSON.stringify({ status: "error", message: "unavailable" })),
);
