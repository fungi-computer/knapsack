import type { InvocationContext } from "@fungi.computer/mycelium";
import { z } from "zod";

import type { FilesPort } from "./files.js";
import { readInputSchema, readOutputSchema } from "./files-read.js";

const readRequestSchema = z.strictObject({
  operation: z.literal("read"),
  input: readInputSchema,
});
const readResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), result: readOutputSchema }),
  z.object({ status: z.literal("error"), message: z.string().min(1) }),
]);

/** Host transport carrying a framed Files read with its invocation context. */
export type FilesReadTransport = (
  frame: string,
  context: InvocationContext,
) => Promise<string>;

/** Validate and encode a bounded Files read request as a JSON frame. */
export function encodeFilesReadRequest(
  input: z.input<typeof readInputSchema>,
): string {
  return JSON.stringify(readRequestSchema.parse({ operation: "read", input }));
}

function decodeFilesReadResponse(input: string) {
  const parsed = readResponseSchema.parse(JSON.parse(input));
  if (parsed.status === "error") throw new Error(parsed.message);
  return parsed.result;
}

/** Adapt a framed transport to the Files read port; `Knapsack.files` owns the operation. */
export function createFilesReadAdapter(
  transport: FilesReadTransport,
): Pick<FilesPort, "read"> {
  return Object.freeze({
    read: async (input, context) =>
      decodeFilesReadResponse(
        await transport(encodeFilesReadRequest(input), context),
      ),
  });
}
