import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createFilesReadAdapter,
  encodeFilesReadRequest,
} from "../src/files-read-codec.js";

const context = {
  executionId: "read-call",
  deadlineAt: null,
  signal: new AbortController().signal,
};
const page = {
  path: "notes.md",
  content: "hello",
  offset: 0,
  nextOffset: null,
  truncated: false,
};

function adapterReplying(frame: string) {
  const sent: string[] = [];
  const adapter = createFilesReadAdapter((request) => {
    sent.push(request);
    return Promise.resolve(frame);
  });
  return { adapter, sent };
}

describe("Files read codec", () => {
  it("encodes one decoded read request and returns the decoded page", async () => {
    const { adapter, sent } = adapterReplying(
      JSON.stringify({ status: "ok", result: page }),
    );
    await expect(
      adapter.read({ path: "notes.md", offset: 0, limit: 4 }, context),
    ).resolves.toEqual(page);
    expect(sent).toEqual([
      encodeFilesReadRequest({ path: "notes.md", offset: 0, limit: 4 }),
    ]);
    expect(JSON.parse(sent[0] ?? "")).toEqual({
      operation: "read",
      input: { path: "notes.md", offset: 0, limit: 4 },
    });
  });

  it("surfaces a host error frame as the read failure", async () => {
    const { adapter } = adapterReplying(
      JSON.stringify({ status: "error", message: "No such file" }),
    );
    await expect(
      adapter.read({ path: "missing.md", offset: 0, limit: 4 }, context),
    ).rejects.toThrow("No such file");
  });

  it("rejects malformed frames", async () => {
    await expect(
      adapterReplying("not json").adapter.read(
        { path: "notes.md", offset: 0, limit: 4 },
        context,
      ),
    ).rejects.toBeInstanceOf(SyntaxError);
    await expect(
      adapterReplying(
        JSON.stringify({ status: "ok", result: { ...page, offset: -1 } }),
      ).adapter.read({ path: "notes.md", offset: 0, limit: 4 }, context),
    ).rejects.toBeInstanceOf(z.ZodError);
  });
});
