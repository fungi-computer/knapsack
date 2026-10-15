import { expect, it } from "vitest";

import { parseCodexPatch } from "../src/patch.js";

it("reads file operations, moves, and hunks in patch order", () => {
  const files = parseCodexPatch(
    [
      "*** Begin Patch",
      "*** Add File: docs/new.md",
      "+# New",
      "+",
      "*** Update File: src/a.ts",
      "*** Move to: src/b.ts",
      "@@ function main",
      " const kept = true;",
      "-const old = 1;",
      "+const next = 2;",
      "@@",
      "-last();",
      "*** End of File",
      "*** Delete File: src/old.ts",
      "*** End Patch",
    ].join("\n"),
  );
  expect(files).toEqual([
    {
      operation: "add",
      path: "docs/new.md",
      hunks: [
        {
          lines: [
            { kind: "add", text: "# New" },
            { kind: "add", text: "" },
          ],
        },
      ],
    },
    {
      operation: "update",
      path: "src/a.ts",
      moveTo: "src/b.ts",
      hunks: [
        {
          context: "function main",
          lines: [
            { kind: "context", text: "const kept = true;" },
            { kind: "remove", text: "const old = 1;" },
            { kind: "add", text: "const next = 2;" },
          ],
        },
        { lines: [{ kind: "remove", text: "last();" }] },
      ],
    },
    { operation: "delete", path: "src/old.ts", hunks: [] },
  ]);
});

it("skips text outside the grammar instead of rejecting it", () => {
  expect(parseCodexPatch("not a patch\n+orphan")).toEqual([]);
});
