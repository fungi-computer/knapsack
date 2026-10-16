import { nanoid } from "@fungi.computer/cairn";
import {
  Mycelium,
  type Access,
  type InvocationContext,
  type LabelledTool,
  type ModuleRegistration,
} from "@fungi.computer/mycelium";
import type { MuleTool, MuleError } from "@fungi.computer/mule/effect";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { patchInputSchema, patchOutputSchema } from "./files-patch.js";
export { patchInputSchema, patchOutputSchema } from "./files-patch.js";
import { patchGrammar } from "./patch-grammar.js";
import { diffLines, formatPatch, structuredPatch } from "diff";
import { z } from "zod";

import {
  maximumReadBytes,
  pathSchema,
  boundedTextSchema,
  readInputSchema,
  readOutputSchema,
} from "./files-read.js";
export { readInputSchema, readOutputSchema };
const maximumPatternCharacters = 512;
const maximumResultEntries = 256;
const maximumReadBytesText = String(maximumReadBytes);
const maximumUnifiedPatchBytes = 65_536;
const utf8 = new TextEncoder();

/** Typed refusal from a bounded or conditional Files edit. */
export type FilesEditErrorReason =
  | "not-found"
  | "ambiguous"
  | "file-too-large"
  | "partial-character"
  | "unchanged"
  | "conflict";

/** Expected Files edit refusal, kept distinct from unexpected host failures. */
export class FilesEditError extends Error {
  constructor(
    readonly reason: FilesEditErrorReason,
    readonly path: string,
    detail: string,
  ) {
    super(`Files edit ${reason}: ${detail} (${path})`);
    this.name = "FilesEditError";
  }
}

/** Bounded directory listing request. */
export const listInputSchema = z.strictObject({
  path: pathSchema,
  limit: z
    .number()
    .int()
    .min(1)
    .max(maximumResultEntries)
    .default(maximumResultEntries),
});
const listEntrySchema = z.lazy(() =>
  z.strictObject({
    path: pathSchema,
    name: z.string().min(1),
    type: z.enum(["file", "directory", "symlink"]),
    size: z.number().int().nonnegative(),
    modifiedAt: z.number(),
  }),
);
/** Directory entries and an explicit truncation flag. */
export const listOutputSchema = z.lazy(() =>
  z.strictObject({
    path: pathSchema,
    entries: z.array(listEntrySchema).max(maximumResultEntries),
    truncated: z.boolean(),
  }),
);
/** Bounded path-pattern search request. */
export const globInputSchema = z.lazy(() =>
  z.strictObject({
    path: pathSchema,
    pattern: z.string().min(1).max(maximumPatternCharacters),
    limit: z
      .number()
      .int()
      .min(1)
      .max(maximumResultEntries)
      .default(maximumResultEntries),
  }),
);
/** Matching paths and an explicit truncation flag. */
export const globOutputSchema = z.lazy(() =>
  z.strictObject({
    path: pathSchema,
    matches: z.array(pathSchema).max(maximumResultEntries),
    truncated: z.boolean(),
  }),
);
/** Bounded content-search request with optional regular-expression matching. */
export const grepInputSchema = z.lazy(() =>
  z.strictObject({
    path: pathSchema,
    pattern: z.string().min(1).max(maximumPatternCharacters),
    regex: z.boolean().default(false),
    ignoreCase: z.boolean().default(false),
    limit: z
      .number()
      .int()
      .min(1)
      .max(maximumResultEntries)
      .default(maximumResultEntries),
  }),
);
/** Content matches and an explicit truncation flag. */
export const grepOutputSchema = z.lazy(() =>
  z.strictObject({
    path: pathSchema,
    matches: z
      .array(
        z.strictObject({
          path: pathSchema,
          line: z.number().int().positive(),
          text: z.string(),
        }),
      )
      .max(maximumResultEntries),
    truncated: z.boolean(),
  }),
);
/** Text replacement request decoded before the captured Files port is called. */
export const editInputSchema = z.lazy(() =>
  z.strictObject({
    path: pathSchema,
    oldText: boundedTextSchema(1),
    newText: boundedTextSchema(),
  }),
);
const editSuccessSchema = z.lazy(() =>
  z.strictObject({
    path: pathSchema,
    bytes: z.number().int().nonnegative(),
    diff: z.string(),
    firstChangedLine: z.number().int().positive().nullable(),
    unifiedPatch: z.string().nullable(),
    unifiedPatchBytes: z.number().int().nonnegative(),
    unifiedPatchAddedLines: z.number().int().nonnegative(),
    unifiedPatchRemovedLines: z.number().int().nonnegative(),
    unifiedPatchTruncated: z.boolean(),
  }),
);
/** Structured edit refusal, including its reason and affected path. */
export const filesEditFailureSchema = z.lazy(() =>
  z.strictObject({
    status: z.literal("failed"),
    error: z.strictObject({
      kind: z.enum([
        "not-found",
        "ambiguous",
        "file-too-large",
        "partial-character",
        "unchanged",
        "conflict",
      ]),
      path: pathSchema,
      message: z.string(),
    }),
  }),
);
/** Successful edit metadata or a typed edit refusal. */
export const editOutputSchema = z.union([
  editSuccessSchema,
  filesEditFailureSchema,
]);

/** Host-owned native patch operation receiving the invocation's deadline and signal. */
export type FilesPatch = (
  input: z.output<typeof patchInputSchema>,
  context: InvocationContext,
) => Promise<z.output<typeof patchOutputSchema>>;

/** Captured host file authority; the host owns path confinement and atomic replacement. */
export type FilesPort = Readonly<{
  /** Omitted when this Files host has no qualified native patch engine. */
  patch?: FilesPatch;
  /** Read a bounded text page. */
  read: (
    input: z.output<typeof readInputSchema>,
    context: InvocationContext,
  ) => Promise<z.output<typeof readOutputSchema>>;
  /** List bounded directory entries. */
  list: (
    input: z.output<typeof listInputSchema>,
    context: InvocationContext,
  ) => Promise<z.output<typeof listOutputSchema>>;
  /** Match bounded paths under the admitted root. */
  glob: (
    input: z.output<typeof globInputSchema>,
    context: InvocationContext,
  ) => Promise<z.output<typeof globOutputSchema>>;
  /** Search bounded file content under the admitted root. */
  grep: (
    input: z.output<typeof grepInputSchema>,
    context: InvocationContext,
  ) => Promise<z.output<typeof grepOutputSchema>>;
  /** Replace atomically only if the stored content still matches the baseline. */
  replace: (
    input: Readonly<{
      path: string;
      expectedContent: string;
      content: string;
    }>,
    context: InvocationContext,
  ) => Promise<Readonly<{ path: string; bytes: number }>>;
}>;

/** Closed set of direct, model-visible Files tools; widening one is an ADR. */
export type FileToolName = "read" | "list" | "glob" | "grep" | "apply_patch";
const fileToolBrand: unique symbol = Symbol("KnapsackFileTool");
/** The one module id that a host's grant for Files names. */
const filesModuleId: FileTool["module"] = "files";

/**
 * A `MuleTool` minted only by this module, named from the closed
 * `FileToolName` set. No host can construct one: the brand has no public
 * constructor, so a host-made `MuleTool` fails typecheck against `files?`.
 */
export type FileTool = LabelledTool &
  Readonly<{ [fileToolBrand]: true }> &
  Readonly<{
    descriptor: Readonly<{ name: FileToolName }>;
    /** Direct tools share the Files module's grant. */
    module: "files";
    access: Access;
  }>;

/** One Mycelium module and the direct Files tools built from the same port. */
export type FilesSurface = Readonly<{
  module: ModuleRegistration;
  tools: readonly FileTool[];
}>;
/** Host inputs for a captured Files connection. */
export type FilesConnectionOptions = Readonly<{
  port: FilesPort;
  /** Session-granted root and path convention published by the host owner. */
  pathInstructions?: string;
}>;

type TextSpan = Readonly<{ start: number; end: number }>;

/**
 * Text folded for retained fuzzy matching. Each folded code unit keeps the
 * source span of the grapheme or line terminator that produced it, so a fuzzy
 * match can be spliced back into the original bytes.
 */
type FuzzyView = Readonly<{
  text: string;
  starts: readonly number[];
  ends: readonly number[];
}>;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const lineTerminator = /\r\n|\r|\n/gu;

function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

function detectLineEnding(content: string): "\n" | "\r\n" {
  const crlf = content.indexOf("\r\n");
  const lf = content.indexOf("\n");
  return lf === -1 || crlf === -1 ? "\n" : crlf < lf ? "\r\n" : "\n";
}

function normalizeToLf(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(content: string, ending: "\n" | "\r\n"): string {
  return ending === "\r\n" ? content.replace(/\n/g, "\r\n") : content;
}

function foldGrapheme(grapheme: string): string {
  return grapheme
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

/** Fold per grapheme and per line (NFKC, typography, trailing space, LF). */
function fuzzyView(content: string): FuzzyView {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  const appendLine = (lineStart: number, lineEnd: number) => {
    const lineOffset = text.length;
    for (const { segment, index } of graphemes.segment(
      content.slice(lineStart, lineEnd),
    )) {
      const folded = foldGrapheme(segment);
      starts.push(...Array<number>(folded.length).fill(lineStart + index));
      ends.push(
        ...Array<number>(folded.length).fill(
          lineStart + index + segment.length,
        ),
      );
      text += folded;
    }
    const kept = lineOffset + text.slice(lineOffset).trimEnd().length;
    text = text.slice(0, kept);
    starts.length = kept;
    ends.length = kept;
  };
  let lineStart = 0;
  for (const terminator of content.matchAll(lineTerminator)) {
    appendLine(lineStart, terminator.index);
    text += "\n";
    starts.push(terminator.index);
    lineStart = terminator.index + terminator[0].length;
    ends.push(lineStart);
  }
  appendLine(lineStart, content.length);
  return { text, starts, ends };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (
    let index = haystack.indexOf(needle);
    index !== -1;
    index = haystack.indexOf(needle, index + 1)
  ) {
    count += 1;
  }
  return count;
}

/**
 * Locate one exact match, else one retained-fuzzy match mapped back to its
 * original span. A fuzzy match that begins or ends inside one folded grapheme
 * has no original span and is refused.
 */
function findEditSpan(
  path: string,
  content: string,
  oldText: string,
): TextSpan {
  const view = fuzzyView(content);
  const needle = fuzzyView(oldText).text;
  const exact = content.indexOf(oldText);
  const fuzzy = needle === "" ? -1 : view.text.indexOf(needle);
  if (exact === -1 && fuzzy === -1) {
    throw new FilesEditError(
      "not-found",
      path,
      "Old text was not found; read the current file and include exact nearby lines",
    );
  }
  if (needle !== "" && countOccurrences(view.text, needle) > 1) {
    throw new FilesEditError(
      "ambiguous",
      path,
      "Old text matches more than once; include more surrounding context",
    );
  }
  if (exact !== -1) return { start: exact, end: exact + oldText.length };
  const last = fuzzy + needle.length - 1;
  const start = view.starts[fuzzy];
  const end = view.ends[last];
  if (
    start === undefined ||
    end === undefined ||
    view.starts[fuzzy - 1] === start ||
    view.ends[last + 1] === end
  ) {
    throw new FilesEditError(
      "partial-character",
      path,
      "Old text matches only part of a character; copy the exact text from the file",
    );
  }
  return { start, end };
}

function generateDiffString(
  oldContent: string,
  newContent: string,
  context = 4,
) {
  const parts = diffLines(oldContent, newContent);
  const output: string[] = [];
  const width = String(
    Math.max(oldContent.split("\n").length, newContent.split("\n").length),
  ).length;
  let firstChangedLine: number | undefined;
  let previousWasChange = false;
  let newLine = 1;
  let oldLine = 1;

  function appendContext(lines: readonly string[], nextIsChange: boolean) {
    if (!previousWasChange && !nextIsChange) return;
    const start = previousWasChange ? 0 : Math.max(0, lines.length - context);
    const end = nextIsChange
      ? lines.length
      : Math.min(lines.length, start + context);
    if (start > 0) output.push(` ${"".padStart(width)} ...`);
    for (const [offset, line] of lines.slice(start, end).entries()) {
      output.push(
        ` ${String(oldLine + start + offset).padStart(width)} ${line}`,
      );
    }
    if (end < lines.length) output.push(` ${"".padStart(width)} ...`);
  }

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined) continue;
    const lines = part.value.split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (part.added || part.removed) {
      firstChangedLine ??= newLine;
      for (const line of lines) {
        if (part.added) {
          output.push(`+${String(newLine).padStart(width)} ${line}`);
          newLine += 1;
        } else {
          output.push(`-${String(oldLine).padStart(width)} ${line}`);
          oldLine += 1;
        }
      }
      previousWasChange = true;
      continue;
    }
    const following = parts[index + 1];
    appendContext(
      lines,
      following?.added === true || following?.removed === true,
    );
    oldLine += lines.length;
    newLine += lines.length;
    previousWasChange = false;
  }
  return { diff: output.join("\n"), firstChangedLine };
}

async function applyEdit(
  port: FilesPort,
  input: z.output<typeof editInputSchema>,
  context: InvocationContext,
): Promise<z.output<typeof editSuccessSchema>> {
  const current = readOutputSchema.parse(
    await port.read(
      {
        path: input.path,
        offset: 0,
        limit: maximumReadBytes,
      },
      context,
    ),
  );
  if (current.truncated) {
    throw new FilesEditError(
      "file-too-large",
      input.path,
      `File exceeds ${maximumReadBytesText} bytes; use files.patch for a small change`,
    );
  }
  const { bom, text: original } = stripBom(current.content);
  const span = findEditSpan(input.path, original, input.oldText);
  const result =
    original.slice(0, span.start) +
    restoreLineEndings(
      normalizeToLf(input.newText),
      detectLineEnding(original),
    ) +
    original.slice(span.end);
  if (original === result)
    throw new FilesEditError(
      "unchanged",
      input.path,
      "Replacement makes no change",
    );
  const replacementContent = bom + result;
  if (utf8.encode(replacementContent).byteLength > maximumReadBytes) {
    throw new FilesEditError(
      "file-too-large",
      input.path,
      `Result exceeds ${maximumReadBytesText} bytes; use files.patch for a small change`,
    );
  }
  const written = await port.replace(
    {
      path: input.path,
      expectedContent: current.content,
      content: replacementContent,
    },
    context,
  );
  // Only the matched span changed; line terminators are presentation here.
  const details = generateDiffString(
    normalizeToLf(original),
    normalizeToLf(result),
  );
  const patch = structuredPatch(
    input.path,
    input.path,
    normalizeToLf(original),
    normalizeToLf(result),
    "",
    "",
    { context: 3 },
  );
  const unified = formatPatch(patch);
  const unifiedPatchBytes = utf8.encode(unified).byteLength;
  const unifiedPatchTruncated = unifiedPatchBytes > maximumUnifiedPatchBytes;
  const lines = patch.hunks.flatMap((hunk) => hunk.lines);
  return {
    path: input.path,
    bytes: written.bytes,
    diff: details.diff,
    firstChangedLine: details.firstChangedLine ?? null,
    unifiedPatch: unifiedPatchTruncated ? null : unified,
    unifiedPatchBytes,
    unifiedPatchAddedLines: lines.filter((line) => line.startsWith("+")).length,
    unifiedPatchRemovedLines: lines.filter((line) => line.startsWith("-"))
      .length,
    unifiedPatchTruncated,
  };
}

/** Apply the same edit behavior as the Files edit operation directly through a captured FilesPort. */
export async function edit(
  port: FilesPort,
  input: z.output<typeof editInputSchema>,
  context: InvocationContext,
): Promise<z.output<typeof editOutputSchema>> {
  try {
    return await applyEdit(port, input, context);
  } catch (cause) {
    if (!(cause instanceof FilesEditError)) throw cause;
    return {
      status: "failed",
      error: {
        kind: cause.reason,
        path: cause.path,
        message: cause.message,
      },
    };
  }
}

/** Cancellation does not finish until the Files owner has acknowledged cleanup. */
function runFileOperation<T>(
  invoke: (context: InvocationContext) => Promise<T>,
) {
  return Effect.callback<T, MuleError>((resume, signal) => {
    const pending = invoke({ executionId: nanoid(), deadlineAt: null, signal });
    void pending.then(
      (result) => {
        resume(Effect.succeed(result));
      },
      (cause: unknown) => {
        resume(
          Effect.fail({
            _tag: "MuleError",
            phase: "tool",
            message:
              cause instanceof Error ? cause.message : "Files operation failed",
          }),
        );
      },
    );
    return Effect.promise(() =>
      pending.then(
        () => undefined,
        () => undefined,
      ),
    );
  });
}

function runPatch(invoke: FilesPatch, input: Parameters<FilesPatch>[0]) {
  return runFileOperation((context) => invoke(input, context));
}

/** Direct presentation of the same validated Files operation. */
function patchTool(invokePatch: FilesPatch): FileTool {
  const tool: MuleTool & FileTool = {
    [fileToolBrand]: true,
    module: filesModuleId,
    access: "write",
    replay: "unsafe",
    descriptor: {
      name: "apply_patch",
      description:
        "Apply a Codex patch to the selected Files root. Example:\n*** Begin Patch\n*** Update File: path/to/file\n@@\n context line\n-old line\n+new line\n*** End Patch\nUse @@ alone or followed by an existing context line; unified-diff @@ line numbers are not supported. Add/Delete File and optional Move to are also supported. Paths stay inside the root; symlinks and parent traversal are rejected. A failure returns recovery guidance and may follow earlier file writes; inspect the result before retrying. Prefer this to shell or Python replacement.",
      // Model-facing parameters derived from the one Zod decoder `prepare` uses.
      parameters: z.toJSONSchema(patchInputSchema),
      constrainedSampling: {
        type: "grammar",
        variants: { openai_lark: patchGrammar },
      },
    },
    executionMode: "sequential",
    prepare: (call) =>
      Effect.try({
        try: () => patchInputSchema.parse(call.arguments),
        catch: (cause) => ({
          message:
            cause instanceof Error ? cause.message : "Invalid patch input",
        }),
      }).pipe(
        Effect.map((value) => ({
          execute: () =>
            Stream.fromEffect(
              runPatch(invokePatch, value).pipe(
                Effect.map((result) => ({
                  type: "result" as const,
                  result: {
                    content: [
                      {
                        type: "text" as const,
                        text: JSON.stringify(result),
                      },
                    ],
                    isError: result.status !== "completed",
                  },
                })),
              ),
            ),
        })),
      ),
  };
  return tool;
}

/** Present the very same Files operation and decoder used behind execute. */
function readOnlyTool<I extends z.ZodType, O extends z.ZodType>(
  name: "read" | "list" | "glob" | "grep",
  description: string,
  inputSchema: I,
  outputSchema: O,
  invoke: (
    input: z.output<I>,
    context: InvocationContext,
  ) => Promise<z.output<O>>,
): FileTool {
  const readOnly: MuleTool & FileTool = {
    [fileToolBrand]: true,
    module: filesModuleId,
    access: "read",
    replay: "safe",
    descriptor: {
      name,
      description,
      parameters: z.toJSONSchema(inputSchema),
    },
    executionMode: "sequential",
    prepare: (call) =>
      Effect.try({
        try: () => inputSchema.parse(call.arguments),
        catch: (cause) => ({
          message:
            cause instanceof Error ? cause.message : "Invalid Files input",
        }),
      }).pipe(
        Effect.map((value) => ({
          execute: () =>
            Stream.fromEffect(
              runFileOperation(async (context) =>
                outputSchema.parse(await invoke(value, context)),
              ).pipe(
                Effect.map((result) => ({
                  type: "result" as const,
                  result: {
                    content: [
                      {
                        type: "text" as const,
                        text: JSON.stringify(result),
                      },
                    ],
                    isError: false,
                  },
                })),
              ),
            ),
        })),
      ),
  };
  return readOnly;
}

/** Build both patch presentations around one injected Files operation. */
export function files(input: FilesConnectionOptions): FilesSurface {
  const describe = (description: string) =>
    input.pathInstructions === undefined
      ? description
      : `${description} ${input.pathInstructions}`;
  const patch = input.port.patch;
  const invokePatch: FilesPatch | undefined =
    patch === undefined
      ? undefined
      : async (value, context) =>
          patchOutputSchema.parse(
            await patch(patchInputSchema.parse(value), context),
          );
  const operations = {
    read: Mycelium.operation({
      replay: "safe",
      access: "read",
      input: readInputSchema,
      output: readOutputSchema,
      description: describe("Read one bounded UTF-8 file page."),
      execute: async (operationInput, context) =>
        input.port.read(operationInput, context),
    }),
    list: Mycelium.operation({
      replay: "safe",
      access: "read",
      input: listInputSchema,
      output: listOutputSchema,
      description: describe("List one bounded directory level."),
      execute: async (operationInput, context) =>
        input.port.list(operationInput, context),
    }),
    glob: Mycelium.operation({
      replay: "safe",
      access: "read",
      input: globInputSchema,
      output: globOutputSchema,
      description: describe("Find bounded paths by pattern."),
      execute: async (operationInput, context) =>
        input.port.glob(operationInput, context),
    }),
    grep: Mycelium.operation({
      replay: "safe",
      access: "read",
      input: grepInputSchema,
      output: grepOutputSchema,
      description: describe("Search bounded file content."),
      execute: async (operationInput, context) =>
        input.port.grep(operationInput, context),
    }),
    edit: Mycelium.operation({
      replay: "unsafe",
      access: "write",
      input: editInputSchema,
      output: editOutputSchema,
      description: describe("Replace one exact or retained-fuzzy text match."),
      execute: async (operationInput, context) =>
        edit(input.port, operationInput, context),
    }),
  };
  const patchOperation =
    invokePatch === undefined
      ? undefined
      : Mycelium.operation({
          replay: "unsafe",
          access: "write",
          input: patchInputSchema,
          output: patchOutputSchema,
          description: describe(
            "Apply a bounded Codex-format patch through the same Files owner as apply_patch.",
          ),
          execute: invokePatch,
        });
  return Object.freeze({
    tools: Object.freeze([
      ...(invokePatch === undefined ? [] : [patchTool(invokePatch)]),
      readOnlyTool(
        "read",
        describe("Read one bounded UTF-8 file page."),
        readInputSchema,
        readOutputSchema,
        input.port.read,
      ),
      readOnlyTool(
        "list",
        describe("List one bounded directory level."),
        listInputSchema,
        listOutputSchema,
        input.port.list,
      ),
      readOnlyTool(
        "glob",
        describe("Find bounded paths by pattern."),
        globInputSchema,
        globOutputSchema,
        input.port.glob,
      ),
      readOnlyTool(
        "grep",
        describe("Search bounded file content."),
        grepInputSchema,
        grepOutputSchema,
        input.port.grep,
      ),
    ]),
    module: Mycelium.module({
      id: filesModuleId,
      name: "files",
      description: "Bounded file operations over one authorized target.",
      operations:
        patchOperation === undefined
          ? operations
          : { ...operations, patch: patchOperation },
    }),
  });
}
