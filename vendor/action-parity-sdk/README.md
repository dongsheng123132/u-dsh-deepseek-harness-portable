# action-parity-sdk

The Action Core for Node, Electron, and TypeScript.

Register a business Action once. The CLI, the MCP server, the Electron IPC
bridge, the HTTP endpoint, and the ActionParity Manifest are all derived from
that one registration. No transport in this package contains business
behavior, and none of them is allowed to be a second implementation.

Requires Node 20 or newer. No runtime dependencies.

```text
npm install action-parity-sdk
```

## The whole loop

```js
// core.mjs — the only file with business behavior
import { createRegistry, defineAction, defineSurface, s } from "action-parity-sdk";

export const registry = createRegistry({
  application: { id: "org.example.notes", name: "Notes", version: "1.0.0" },
  surfaces: [
    defineSurface({ id: "gui", kind: "gui", bindingTarget: "data-action-id={action_id}" }),
    defineSurface({ id: "cli", kind: "cli", bindingTarget: "notes {action_id} --json" }),
    defineSurface({ id: "mcp", kind: "mcp", bindingTarget: "tool:{action_id}" })
  ]
});

registry.register(
  defineAction({
    id: "note.create",
    title: "Create note",
    description: "Create one note.",
    effects: "write",
    input: s.object({ title: s.string({ minLength: 1 }) }),
    output: s.object({ id: s.string(), title: s.string() }),
    handler: (input) => store.add(input.title)
  })
);
```

```js
// cli.mjs — the entire CLI Shadow
import { createCliRunner } from "action-parity-sdk/cli";
import { registry } from "./core.mjs";
await createCliRunner(registry, { name: "notes" }).main();
```

```js
// mcp.mjs — the entire MCP Shadow
import { serveMcpStdio } from "action-parity-sdk/mcp";
import { registry } from "./core.mjs";
await serveMcpStdio(registry);
```

```js
// electron main process — the entire GUI Shadow
import { attachElectronIpc } from "action-parity-sdk/electron";
attachElectronIpc(ipcMain, registry, { confirm: askTheHuman });
```

Adding `note.archive` to `core.mjs` gives the CLI a command with flags, help
text, and exit codes; gives the agent a new MCP tool; gives the GUI a catalog
entry; and adds four Bindings to the Manifest. None of the Shadow files change.

## Generate the published contract

```text
notes export > registry-bundle.json
action-parity generate registry-bundle.json --out-dir generated --typescript
action-parity generate registry-bundle.json --out-dir generated --typescript --check
```

`--check` never writes. It reports `current`, `missing`, or `drifted` per file
and exits nonzero, which is what belongs in CI. The generated
`action-client.ts` gives the renderer Action constants and input/output types
derived from the same schemas the core validates against.

## What the core enforces, below every Surface

| Concern | Behavior |
| --- | --- |
| Input | Validated once, in the core. Every Surface gets the same located issues. |
| Output | A result that violates its declared schema is `output_validation_failed`, not a silently wrong Manifest. |
| Confirmation | `financial`, `destructive`, `high`, and `critical` Actions refuse to run without explicit confirmation. Calling the MCP tool instead of the GUI button does not bypass it. |
| Permission | `authorize` runs before the handler for every Surface. |
| Stale state | `expectedStateVersion` mismatch returns `conflict / state_version_conflict` and does not execute. Last-writer-wins is never the unstated default. |
| Retries | `idempotencyKey` replays the first envelope instead of writing twice. |
| Timeouts | The declared `timeout_ms` is enforced and the handler's `context.signal` is aborted. |
| Failures | A handler that throws anything still produces a valid envelope. |
| Audit | `onEvent` receives `action.started` / `succeeded` / `failed` with references, not payloads. |

## The envelope

Every Surface receives the same object, byte-compatible with the Rust
`action-parity-core` envelope:

```json
{ "ok": true, "version": 1, "action_id": "note.create", "execution_id": "ap-...", "result": { } }
{ "ok": false, "version": 1, "action_id": "note.create", "execution_id": "ap-...",
  "error": { "class": "input", "code": "input_validation_failed", "message": "...", "details": { } } }
```

Error classes: `input`, `refused`, `not_found`, `conflict`, `timeout`,
`unavailable`, `internal`.

## Schemas

`s` is a small builder that returns plain JSON Schema, so it is a convenience
and never a lock-in. Hand-written JSON Schema works in the same places.

Zod, Valibot, and ArkType users keep their validator and publish the schema
explicitly:

```js
import { z } from "zod";
import { fromStandardSchema } from "action-parity-sdk";

const Input = z.object({ title: z.string().min(1) });

defineAction({
  // ...
  input: fromStandardSchema(Input, z.toJSONSchema(Input)),
  handler: (input) => { /* input is typed by Zod */ }
});
```

The JSON Schema stays explicit because the Manifest, the MCP tool list, and the
CLI catalog are published contracts. Deriving them implicitly would let a
library upgrade silently rewrite a published interface.

## Machine contract of the generated CLI

- stdout carries results only; stderr carries diagnostics only
- `--json` prints exactly one `ExecutionEnvelope` with a stable `ok` field
- no ANSI, no spinner, no prompt when stdout is not a TTY
- `--input-json` accepts inline JSON, `@file`, or `-` for stdin
- exit codes: `0` ok, `1` runtime error, `2` usage, `3` invalid input,
  `4` refused, `5` state conflict, `6` unknown Action, `7` timeout

Built-in subcommands: `list`, `describe <action-id>`, `export [bundle|manifest|cli-help|mcp-tools]`,
and `mcp`, which serves the MCP Shadow from the same binary.

## MCP details

`tools/list` returns exactly `registry.mcpTools()` — the same object
`action-parity generate` writes to `mcp-tools.json`, so the server and the
published artifact cannot disagree.

Business failures come back as tool results with `isError: true` and the
envelope in `content[0].text`. Protocol faults stay JSON-RPC errors. A
high-risk Action answers `confirmation_required`; the agent must ask its human
and retry with `_meta: { "actionparity/confirmed": true }`.

`_meta` also carries `actionparity/execution_id`,
`actionparity/idempotency_key`, and `actionparity/expected_state_version`.

## Related

- Specification and toolchain: [ActionParity](https://github.com/dongsheng123132/action-parity)
- Rust equivalent: `action-parity-core`
- Worked example: [`examples/node-registry`](../../examples/node-registry)

Apache-2.0.
