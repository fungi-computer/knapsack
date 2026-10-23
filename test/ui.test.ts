import { Mycelium, type CapabilitySource } from "@fungi.computer/mycelium";
import { directSandbox } from "@fungi.computer/mycelium/testing";
import { expect, it } from "vitest";

import { Knapsack } from "../src/index.js";

const sessionId = "session-ui";

/** A claim POST reaches a live host (400 for this body) or none (404). */
async function hostIsLive(
  connection: ReturnType<typeof Knapsack.ui>,
): Promise<boolean> {
  const response = await connection.fetch(
    new Request(`http://owner/browser/sessions/${sessionId}/browser/claims`, {
      method: "POST",
      body: "{}",
    }),
  );
  if (response.status !== 400 && response.status !== 404)
    throw new Error(`Unexpected claim status ${String(response.status)}`);
  return response.status === 400;
}

function runtimeFor(
  sources: readonly CapabilitySource[],
  session: string | undefined,
) {
  const sandbox = directSandbox(() => Promise.resolve(null));
  return Mycelium.make(
    session === undefined
      ? { sources, sandbox }
      : { sources, sandbox, session: { sessionId: session } },
  );
}

function offeredPaths(
  lease: Awaited<ReturnType<Awaited<ReturnType<typeof runtimeFor>>["acquire"]>>,
): readonly string[] {
  return lease.catalog.list({}).results.map(({ path }) => path);
}

it("Knapsack.ui lends each Session run its ui module and releases the borrow when the run ends", async () => {
  const connection = Knapsack.ui({
    id: "test-ui",
    hasSession: () => Promise.resolve(true),
  });
  const runtime = await runtimeFor([connection.source], sessionId);
  try {
    const lease = await runtime.acquire();
    expect(offeredPaths(lease)).toEqual(
      expect.arrayContaining(["ui.discover", "ui.execute"]),
    );
    expect(await hostIsLive(connection)).toBe(true);
    await lease.release();
  } finally {
    await runtime.close();
  }
  expect(await hostIsLive(connection)).toBe(false);
  await connection.close();
});

it("Knapsack.ui contributes no module to a Session-free acquisition", async () => {
  const connection = Knapsack.ui({
    id: "test-ui",
    hasSession: () => Promise.resolve(true),
  });
  const runtime = await runtimeFor([connection.source], undefined);
  try {
    const lease = await runtime.acquire();
    expect(offeredPaths(lease)).not.toContain("ui.discover");
    await lease.release();
  } finally {
    await runtime.close();
  }
  await connection.close();
});

it("Knapsack.ui releases a run's borrow when another source fails the acquisition", async () => {
  const connection = Knapsack.ui({
    id: "test-ui",
    hasSession: () => Promise.resolve(true),
  });
  const failing: CapabilitySource = {
    id: "failing",
    acquire: () => Promise.reject(new Error("source unavailable")),
  };
  const runtime = await runtimeFor([connection.source, failing], sessionId);
  try {
    await expect(runtime.acquire()).rejects.toThrow();
  } finally {
    await runtime.close();
  }
  expect(await hostIsLive(connection)).toBe(false);
  await connection.close();
});

it("closing Knapsack.ui refuses later runs and browser requests", async () => {
  const connection = Knapsack.ui({
    id: "test-ui",
    hasSession: () => Promise.resolve(true),
  });
  await connection.close();
  const runtime = await runtimeFor([connection.source], sessionId);
  try {
    await expect(runtime.acquire()).rejects.toThrow();
  } finally {
    await runtime.close();
  }
  const events = await connection.fetch(
    new Request(`http://owner/browser/sessions/${sessionId}/browser/events`),
  );
  expect(events.status).toBe(410);
});
