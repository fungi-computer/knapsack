import * as z from "zod";
import { boundedTextSchema, maximumReadBytes } from "./files-read.js";

/** Browser-safe patch contracts shared by native Files tools and Computer HTTP. */
export const patchInputSchema = z.strictObject({
  patch: boundedTextSchema(1).meta({
    description: `Codex patch text, at most ${String(maximumReadBytes)} UTF-8 bytes.`,
  }),
});
const patchResultSchema = z.strictObject({
  status: z.enum(["completed", "failed", "cancelled"]),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
});
/** Native patch completion, cancellation or failure, including an optional mismatch. */
export const patchOutputSchema = z.union([
  patchResultSchema,
  patchResultSchema.extend({
    error: z.strictObject({ kind: z.literal("mismatch") }),
  }),
]);
