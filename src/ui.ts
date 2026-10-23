import type {
  CapabilitySource,
  CapabilitySourceAcquisition,
  CapabilitySourceContext,
} from "@fungi.computer/mycelium";

import { createUiHost } from "./ui/host.js";
import { BrowserSessions } from "./ui/sessions.js";

/** How one Agent host connects its Sessions' open Apps to Knapsack.ui. */
export type UiConnectionOptions = Readonly<{
  /** Stable, secret-free capability source id, such as `"hub-ui"`. */
  id: string;
  /** Whether the Session is stored; only a stored Session's browser may connect. */
  hasSession: (sessionId: string) => Promise<boolean>;
}>;

/**
 * Live commands of the App open in each Agent Session's browser. The Agent
 * reaches them through the `ui` module (`ui.discover`, `ui.execute`); the
 * browser runs them through Whistle over the transport this connection serves.
 */
export type UiConnection = Readonly<{
  /**
   * Each Session run borrows its Session's `ui` module and releases it when
   * the run ends. A Session-free acquisition contributes no module.
   */
  source: CapabilitySource;
  /**
   * Serve `/browser/sessions/<sessionId>/browser/{events,claims,results}`.
   * It authenticates nobody: mount it behind the host's own authorization.
   */
  fetch: (request: Request) => Promise<Response>;
  /** End every browser stream; later requests answer 410 and later borrows fail. */
  close: () => Promise<void>;
}>;

/** Borrow one Session's `ui` module for the acquiring run. */
function borrow(
  sessions: BrowserSessions,
  context: CapabilitySourceContext,
): CapabilitySourceAcquisition {
  context.signal.throwIfAborted();
  if (context.session === undefined)
    return {
      snapshot: { version: "no-session", modules: [] },
      release: () => Promise.resolve(),
    };
  const sessionId = context.session.sessionId;
  const lease = sessions.acquire(sessionId);
  return {
    snapshot: { version: `session:${sessionId}`, modules: lease.modules },
    release: () => {
      lease.release();
      return Promise.resolve();
    },
  };
}

/** Connect the open App's live Whistle commands to each Agent Session. */
export function ui(options: UiConnectionOptions): UiConnection {
  const sessions = new BrowserSessions(
    () => createUiHost(),
    options.hasSession,
  );
  return Object.freeze({
    source: {
      id: options.id,
      // The executor turns a refused borrow (aborted, or closed) into a rejection.
      acquire: (context) =>
        new Promise((resolve) => {
          resolve(borrow(sessions, context));
        }),
    },
    fetch: (request) => sessions.fetch(request),
    close: () => sessions.close(),
  });
}
