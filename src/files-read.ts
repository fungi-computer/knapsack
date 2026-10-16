import * as z from "zod";

/** Maximum UTF-8 byte length of a Files text page. */
export const maximumReadBytes = 128 * 1_024;
const utf8 = new TextEncoder();

/** Nonempty file path bounded to 4,096 characters, without null bytes. */
export const pathSchema = z.lazy(() =>
  z
    .string()
    .min(1)
    .max(4_096)
    .refine((path) => !path.includes("\0"), "Path cannot contain null bytes"),
);

/** Validate text against a minimum character length and the Files UTF-8 byte limit. */
export function boundedTextSchema(minimumLength = 0) {
  return z
    .string()
    .min(minimumLength)
    .refine(
      (content) => utf8.encode(content).byteLength <= maximumReadBytes,
      `Text exceeds the ${String(maximumReadBytes)}-byte Files bound`,
    );
}

/** Canonical bounded Files read request and result, shared with display consumers. */
export const readInputSchema = z.lazy(() =>
  z.strictObject({
    path: pathSchema,
    offset: z.number().int().min(0).default(0),
    limit: z
      .number()
      .int()
      .min(4)
      .max(maximumReadBytes)
      .default(maximumReadBytes),
  }),
);
/** Bounded text page, continuation offset and optional hosted file identity. */
export const readOutputSchema = z.lazy(() =>
  z.strictObject({
    path: pathSchema,
    content: boundedTextSchema(),
    offset: z.number().int().min(0),
    nextOffset: z.number().int().min(0).nullable(),
    truncated: z.boolean(),
    /** Captured hosted file identity; a local Files host may have no Computer identity. */
    file: z
      .strictObject({
        computerId: z.string().min(1).max(256),
        path: pathSchema.refine(
          (path) => path.startsWith("/"),
          "Computer file paths must be absolute",
        ),
      })
      .exactOptional(),
  }),
);
