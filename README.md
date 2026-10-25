# @fungi.computer/knapsack

Knapsack collects Agent tool connections. A connection discovers one external
capability provider and projects its advertised operations into a Mycelium
`CapabilitySource`.

The first connection is `Knapsack.computer`. A Computer provider continues to
own its operation implementations, schemas, storage, and execution. Knapsack
parses the provider's advertisement and forwards generic calls; Mycelium owns
the resulting capability lifecycle and execute door.

`Knapsack.computers` captures a host's Computer list. Computers are described
concurrently under a timeout; one that rejects, hangs, or advertises an unusable
schema is dropped and reported through `onUnavailable`, while the remaining
Computers stay available. There is no implicit shared Files module. A connection
may supply its own `files` port and `namespace: ["computers"]`; its advertised
commands and nested `files.*` then share that Computer’s authority id under
`env.computers.<name>`. Failed acquisition removes that Computer’s Files with
its commands.

`Knapsack.files` projects one bounded Files port as the `files` module and, when
the host supplies a patch engine, the direct `apply_patch` tool. Both decode
through the same Zod schemas.

`Knapsack.mcpServers` connects a host-owned list of remote MCP servers with the
maintained MCP SDK client over Streamable HTTP. Each server becomes the module
`env.mcp.<name>`, one operation per advertised tool. A tool name maps onto the
guest identifier grammar (`create-note` becomes `create_note`). Its input schema
decodes through Forage's JSON Schema subset; a schema outside that subset still
accepts a JSON object, and the server validates it. A tool replays only when the
server marks it `readOnlyHint`. A call returns the tool's `structuredContent`,
or `{ isError, content }` when there is none or the tool failed. The host
supplies the `fetch` that carries every request and any headers, such as a
bearer token; redirects are refused, and headers never reach the snapshot, the
catalog or a result. Servers connect concurrently under a timeout. One that
rejects, refuses its credential, times out or advertises an unusable list is
dropped and reported through `onUnavailable`, while the others stay available.

`Knapsack.ui({ id, hasSession })` connects the App open in an Agent Session's
browser. Its `source` lends each Session run the `ui` module: `ui.discover`
lists the App's live Whistle commands (its agent projection) and `ui.execute`
runs one. The run returns the module when it ends. Its `fetch` serves
`/browser/sessions/<sessionId>/browser/{events,claims,results}`: the browser
claims each request before it runs it, and the host accepts only the matching
result. The browser side is `connectBrowser({ baseUrl, whistle })` from
`@fungi.computer/knapsack/ui/browser`.

Knapsack does not own model loops, tool execution policy, Computer storage, or
provider-specific operations.

`@fungi.computer/knapsack/files-patch` exposes the same patch input/output
contracts without loading tool connections or the agent runtime. Browser and
transport consumers use this subpath.

`@fungi.computer/knapsack/files-search` supplies `SearchVisibility` to Local and
hosted Files adapters. One invocation-local policy checks canonical
root-relative search paths (the root and every entry), excludes `.git` path
components and respects excluded ancestors. Adapters supply bounded ignore-file
text; maintained `ignore` owns gitignore grammar and nested negation. Exact-path
reads do not use search visibility.

## Set up

```sh
npm install @fungi.computer/knapsack
```

The package is an ESM public candidate, not a claim of npm publication. It
depends on Cairn, Forage, Mule, Mycelium, the MCP SDK client, Effect, Zod and
`diff` and `ignore`. Its explicit file list contains compiled JavaScript and
declarations, the API reference, this README and the license texts. It has no
install scripts.

## Quick start: validate a read request

This example uses the same public decoder as the packed-consumer proof in
[test/stranger/runtime.mjs](test/stranger/runtime.mjs). It validates a request;
it does not grant file access or perform I/O.

```ts
import { readInputSchema } from "@fungi.computer/knapsack";

export const request = readInputSchema.parse({
  path: "notes.md",
  offset: 0,
  limit: 4,
});
```

## Core concepts

The host supplies an already admitted Computer or Files port. Knapsack does not
mint credentials or choose a Team, member, Computer, path root or permission.
`Knapsack.computer({ id, name, computer })` captures the Computer's advertised
operations. `Knapsack.computers` subscribes to a host-owned connection list and
invalidates its captured modules when that list changes.

Computer calls preserve Mycelium's invocation context, including its execution
identity, abort signal and deadline. Advertised Computer operations are marked
unsafe to replay because their implementation can change external state. The
host's provider remains responsible for admission on each call. An interactive
host may set `confirmCalls: true` on its Computer connection to request Mycelium
confirmation before every advertised call. The advertisement does not
distinguish read-only from mutating operations, so this policy confirms both;
other connections keep their existing approval policy.

`Knapsack.files({ port })` builds a Files module and direct tools from one port.
Text edits use `port.replace` with the expected original content; the host must
replace atomically or refuse a conflict. A native patch operation is available
only when that port supplies a patch engine. Paths are validated, not confined
by Knapsack: the captured host port enforces its own root and authority.

`Knapsack.ui` keeps one browser host per Session, opened by the browser's event
stream for a stored Session or by a run, and dropped when neither holds it.
Neither its `fetch` nor the browser's requests are authenticated by Knapsack:
mount `fetch` behind the host's own admission. `close()` ends every stream;
later requests answer 410 and later runs fail to borrow.

## API reference

The [generated reference](docs/api/README.md) covers every public entry:

| Entry               | Use                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------- |
| Root                | Computer sources, Files connections, edit operations and their codecs.                      |
| `/files-patch`      | Patch input/output codecs without the tool runtime.                                         |
| `/files-read`       | Bounded text read schemas and shared path validation.                                       |
| `/patch`            | Read Codex patch operations for presentation; the native engine validates and applies them. |
| `/files-read-codec` | Encode read requests and adapt a framed host transport to the Files read port.              |
| `/ui/browser`       | Connect an App's Whistle runtime to one Agent Session's `Knapsack.ui` transport.            |

## Examples and checks

[Computer tests](test/computer.test.ts) exercise acquisition, invalidation,
provider failures and invocation context. [Files tests](test/files.test.ts)
exercise bounded reads and edits.
[Read codec tests](test/files-read-codec.test.ts) exercise the framed transport.
[Knapsack.ui tests](test/ui.test.ts) exercise run borrows and teardown; the
[host](test/ui-host.test.ts), [event stream](test/ui-eventsource.test.ts) and
[Session host](test/ui-sessions.test.ts) tests cover discovery, execution,
claims, disconnects and multi-tab delivery. The packed-consumer runtime and
typecheck fixtures import the root and Files entries from an isolated tarball
installation.

From a configured repository checkout:

```sh
pnpm turbo:run run build --filter=@fungi.computer/knapsack
pnpm --dir packages/knapsack run test
pnpm --dir packages/knapsack run docs
pnpm --dir packages/knapsack run stranger
```

## Limits and errors

A Computer advertises at most 256 capabilities. Each advertisement read has a
10-second default timeout; list acquisition describes at most eight Computers
concurrently. An unavailable Computer is reported through `onUnavailable` and
omitted without removing healthy ones. Cancelling acquisition rejects it.

Files reads and patch inputs are bounded to 128 KiB of UTF-8 text. Listing and
search results contain at most 256 entries and expose truncation. Schemas reject
invalid requests and results. `FilesEditError` distinguishes conflicts, missing
or ambiguous matches, oversized files and partial-character edits.

One Session's browser serves one outstanding request: a second gets
`browser_busy`, a missing browser `browser_not_connected`. If the browser
disconnects after it claimed an execution, the result is
`browser_execution_indeterminate`, because the command may already have run.

## Contribute and license

Knapsack's package license is [MIT](LICENSE). The retained Codex patch grammar
in `src/patch-grammar.ts` carries its existing
[Apache-2.0 license](LICENSE.codex), which is included in the tarball. Keep host
authority separate from connection projection and run the package and
packed-consumer checks before proposing a change. Publication is a separate
release decision.
