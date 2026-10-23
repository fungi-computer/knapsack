import * as Base64 from "effect/encoding/Base64";
import * as z from "zod";

/** Maximum UTF-8 byte length of a Files text page. */
export const maximumReadBytes = 128 * 1_024;
/** Maximum byte length of an image the read tool returns; a host refuses an image it cannot bring within it. */
export const maximumImageBytes = 512 * 1_024;
const utf8 = new TextEncoder();

const signatures = [
  {
    mimeType: "image/png",
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  { mimeType: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mimeType: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] },
  { mimeType: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] },
] as const;
const riff = [0x52, 0x49, 0x46, 0x46];
const webp = [0x57, 0x45, 0x42, 0x50];

/** Bytes needed at the start of a file to recognise a supported image. */
export const imageSniffBytes = 12;

const hasBytesAt = (
  head: Uint8Array,
  offset: number,
  bytes: readonly number[],
) => bytes.every((byte, index) => head[offset + index] === byte);

/** Identify png, jpeg, gif or webp by their full magic bytes; `undefined` means not a supported image. */
export function sniffImageMimeType(head: Uint8Array): string | undefined {
  for (const { mimeType, bytes } of signatures)
    if (hasBytesAt(head, 0, bytes)) return mimeType;
  return hasBytesAt(head, 0, riff) && hasBytesAt(head, 8, webp)
    ? "image/webp"
    : undefined;
}

/** Message for an image above a host's read cap, shared by every Files host. */
export function imageTooLargeMessage(
  path: string,
  size: number,
  limit: number,
): string {
  return `Image ${path} is ${String(size)} bytes; the read limit is ${String(limit)} bytes. Refusing to read it.`;
}

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
const fileIdentitySchema = z.lazy(() =>
  z.strictObject({
    computerId: z.string().min(1).max(256),
    path: pathSchema.refine(
      (path) => path.startsWith("/"),
      "Computer file paths must be absolute",
    ),
  }),
);
/** The image types a Files read can return. */
export const readImageMimeType = z.enum([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
/** Whole png, jpeg, gif or webp file, at most `maximumImageBytes`, as base64. */
export const readImageOutputSchema = z.lazy(() =>
  z.strictObject({
    path: pathSchema,
    image: z.strictObject({
      mimeType: readImageMimeType,
      data: z.base64(),
      bytes: z.number().int().min(1).max(maximumImageBytes),
    }),
    file: fileIdentitySchema.exactOptional(),
  }),
);
/** Bounded text page, continuation offset and optional hosted file identity. */
export const readTextOutputSchema = z.lazy(() =>
  z.strictObject({
    path: pathSchema,
    content: boundedTextSchema(),
    offset: z.number().int().min(0),
    nextOffset: z.number().int().min(0).nullable(),
    truncated: z.boolean(),
    /** Captured hosted file identity; a local Files host may have no Computer identity. */
    file: fileIdentitySchema.exactOptional(),
  }),
);
/**
 * What guest code and MCP callers see: an image never travels as base64 in the
 * value. It is pushed through the execution's image collector and the value is
 * only this caption.
 */
export const readImageCaptionSchema = z.lazy(() =>
  z.strictObject({
    path: pathSchema,
    image: z.strictObject({
      ref: z.string().min(1).max(32),
      mimeType: readImageMimeType,
      bytes: z.number().int().min(1).max(maximumImageBytes),
    }),
  }),
);
/** Text page or image caption returned to guest code. */
export const readGuestOutputSchema = z.lazy(() =>
  z.union([readTextOutputSchema, readImageCaptionSchema]),
);
/** A bounded text page or a whole image; images are only read from offset 0. */
export const readOutputSchema = z.lazy(() =>
  z.union([readTextOutputSchema, readImageOutputSchema]),
);

/** Build the image read result for a recognised image's complete bytes. */
export function imageReadResult(
  path: string,
  mimeType: string,
  bytes: Uint8Array,
): z.output<typeof readImageOutputSchema> {
  return readImageOutputSchema.parse({
    path,
    image: { mimeType, data: Base64.encode(bytes), bytes: bytes.byteLength },
  });
}
