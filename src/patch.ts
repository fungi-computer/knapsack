/**
 * Presentation reading of the Codex `apply_patch` grammar (see
 * `patch-grammar.ts`). Pure and side-effect free: display consumers import it
 * through `@fungi.computer/knapsack/patch`. The native patch engine, not this
 * reader, validates and applies patches, so the reader is tolerant: text that
 * does not match the grammar is skipped rather than rejected.
 */

/** One body line of an update or add hunk. */
export type CodexPatchLine = Readonly<{
  kind: "add" | "context" | "remove";
  text: string;
}>;

/** One `@@` change block; `context` is the text after `@@`, when present. */
export type CodexPatchHunk = Readonly<{
  context?: string | undefined;
  lines: readonly CodexPatchLine[];
}>;

/** One file operation in a patch, in patch order. */
export type CodexPatchFile = Readonly<{
  operation: "add" | "delete" | "update";
  path: string;
  /** Destination of an update with `*** Move to:`. */
  moveTo?: string | undefined;
  hunks: readonly CodexPatchHunk[];
}>;

const fileHeaders = [
  ["*** Add File: ", "add"],
  ["*** Delete File: ", "delete"],
  ["*** Update File: ", "update"],
] as const;
const moveHeader = /^\*\*\* Move to: (.+)$/u;
type MutableFile = {
  operation: CodexPatchFile["operation"];
  path: string;
  moveTo?: string;
  hunks: { context?: string; lines: CodexPatchLine[] }[];
};

function bodyLine(line: string): CodexPatchLine | undefined {
  if (line.startsWith("+")) return { kind: "add", text: line.slice(1) };
  if (line.startsWith("-")) return { kind: "remove", text: line.slice(1) };
  if (line.startsWith(" ")) return { kind: "context", text: line.slice(1) };
  return undefined;
}

/** Read the file operations of one Codex patch, in order. */
export function parseCodexPatch(patch: string): readonly CodexPatchFile[] {
  const files: MutableFile[] = [];
  let file: MutableFile | undefined;
  for (const line of patch.split("\n")) {
    const header = fileHeaders.find(([prefix]) => line.startsWith(prefix));
    if (header !== undefined) {
      const [prefix, operation] = header;
      file = { operation, path: line.slice(prefix.length).trim(), hunks: [] };
      files.push(file);
      continue;
    }
    if (file === undefined) continue;
    const move = moveHeader.exec(line);
    if (move !== null) {
      file.moveTo = (move[1] ?? "").trim();
      continue;
    }
    if (line.startsWith("@@")) {
      const context = line.slice(2).trim();
      file.hunks.push(context === "" ? { lines: [] } : { context, lines: [] });
      continue;
    }
    const body = bodyLine(line);
    if (body === undefined) continue;
    const hunk = file.hunks.at(-1) ?? { lines: [] };
    if (file.hunks.length === 0) file.hunks.push(hunk);
    hunk.lines.push(body);
  }
  return files;
}
