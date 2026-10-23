import * as z from "zod";
import { boundedTextSchema, maximumReadBytes } from "./files-read.js";

/** Browser-safe patch contracts shared by native Files tools and Computer HTTP. */
export const patchInputSchema = z.lazy(() =>
  z.strictObject({
    patch: boundedTextSchema(1).meta({
      description: `Codex patch text, at most ${String(maximumReadBytes)} UTF-8 bytes.`,
    }),
  }),
);
/** One patch output stream cut at its byte bound; absent streams were whole. */
const patchTruncationSchema = z.strictObject({
  stream: z.enum(["stdout", "stderr"]),
  keptBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().positive(),
});
const patchResultSchema = z.strictObject({
  status: z.enum(["completed", "failed", "cancelled"]),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  /** `false` when both streams are whole, else one entry per cut stream. */
  truncated: z.union([z.literal(false), z.array(patchTruncationSchema).min(1)]),
});
/** Native patch completion, cancellation or failure, including an optional mismatch. */
export const patchOutputSchema = z.lazy(() =>
  z.union([
    patchResultSchema,
    patchResultSchema.extend({
      error: z.strictObject({ kind: z.literal("mismatch") }),
    }),
  ]),
);
