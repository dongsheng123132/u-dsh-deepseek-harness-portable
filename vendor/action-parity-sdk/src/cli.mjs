/**
 * The CLI Shadow.
 *
 * This file contains no business behavior. It parses argv, calls
 * `registry.dispatch`, and prints the envelope. Adding an Action to the
 * registry adds a command, its flags, its help text, and its exit codes with
 * no edit here — that is the whole point of the Action Core.
 *
 * Machine contract:
 *   stdout   results only
 *   stderr   diagnostics only
 *   --json   one ExecutionEnvelope per line, with a stable `ok` field
 *   no ANSI, no spinner, no prompt when stdout is not a TTY
 */

import { readFile } from "node:fs/promises";
import process from "node:process";
import { coerceStringValue, describeFlags } from "./schema.mjs";
import { confirmationRequired } from "./registry.mjs";

/** Exit codes are part of the contract; changing one is a breaking change. */
export const EXIT = Object.freeze({
  ok: 0,
  error: 1,
  usage: 2,
  input: 3,
  refused: 4,
  conflict: 5,
  not_found: 6,
  timeout: 7
});

const CLASS_EXIT = {
  input: EXIT.input,
  refused: EXIT.refused,
  conflict: EXIT.conflict,
  timeout: EXIT.timeout,
  not_found: EXIT.not_found,
  unavailable: EXIT.error,
  internal: EXIT.error
};

const RESERVED = new Set([
  "--json",
  "--yes",
  "-y",
  "--input-json",
  "--execution-id",
  "--idempotency-key",
  "--expected-state-version",
  "--help",
  "-h"
]);

export function createCliRunner(registry, options = {}) {
  return new CliRunner(registry, options);
}

export class CliRunner {
  #registry;
  #name;
  #version;
  #surface;
  #stdout;
  #stderr;
  #stdin;

  constructor(registry, options = {}) {
    this.#registry = registry;
    this.#name = options.name ?? registry.application.id;
    this.#version = options.version ?? registry.application.version;
    this.#surface = options.surface ?? "cli";
    this.#stdout = options.stdout ?? process.stdout;
    this.#stderr = options.stderr ?? process.stderr;
    this.#stdin = options.stdin ?? process.stdin;
  }

  /** Run once and resolve with the exit code. Never throws for user error. */
  async run(argv = process.argv.slice(2)) {
    const args = [...argv];
    const json = takeFlag(args, "--json");

    if (args.length === 0) {
      this.#err(this.helpText());
      return EXIT.usage;
    }
    if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
      this.#out(this.helpText());
      return EXIT.ok;
    }
    if (args[0] === "--version" || args[0] === "-V") {
      this.#out(json ? stringify({ name: this.#name, version: this.#version }) : this.#version);
      return EXIT.ok;
    }

    const command = args.shift();
    switch (command) {
      case "list":
        return this.#list(json);
      case "describe":
        return this.#describe(args[0], json);
      case "export":
        return this.#export(args[0] ?? "bundle");
      case "mcp":
        return this.#mcp();
      case "call":
        return this.#call(args.shift(), args, json);
      default:
        return this.#call(command, args, json);
    }
  }

  /** Convenience entry point for a bin script. */
  async main(argv = process.argv.slice(2)) {
    process.exitCode = await this.run(argv);
    return process.exitCode;
  }

  helpText(actionId = null) {
    if (actionId) return this.#actionHelp(actionId);
    const lines = [
      `${this.#registry.application.name} ${this.#version}`,
      this.#registry.application.description ?? "",
      "",
      "Usage:",
      `  ${this.#name} <action-id> [--flag value ...] [--json] [--yes]`,
      `  ${this.#name} call <action-id> --input-json '<json>' [--json]`,
      `  ${this.#name} list [--json]`,
      `  ${this.#name} describe <action-id> [--json]`,
      `  ${this.#name} export [bundle|manifest|cli-help|mcp-tools]`,
      `  ${this.#name} mcp`,
      "",
      "Actions:"
    ];
    for (const action of this.#registry.actionsForSurface(this.#surface)) {
      const mark = confirmationRequired(action.effects) ? " (needs --yes)" : "";
      lines.push(`  ${action.id.padEnd(28)} ${action.title}${mark}`);
    }
    lines.push(
      "",
      "Common options:",
      "  --json                      print one ExecutionEnvelope with a stable ok field",
      "  --yes, -y                   supply the confirmation high-risk Actions require",
      "  --input-json <json|@file|->  send the whole input as JSON instead of flags",
      "  --execution-id <id>         propagate a caller trace ID into the Action Core",
      "  --idempotency-key <key>     replay-safe retry of the same write",
      "  --expected-state-version <v>  refuse to act on stale state",
      "",
      "Exit codes:",
      "  0 ok   1 runtime error   2 usage   3 invalid input   4 refused",
      "  5 state conflict   6 unknown action   7 timeout"
    );
    return lines.filter((line, index) => !(index === 1 && line === "")).join("\n");
  }

  #actionHelp(actionId) {
    const action = this.#registry.action(actionId);
    if (!action) return `Unknown Action ${actionId}.`;
    const lines = [
      `${action.id}  ${action.title}`,
      action.description,
      "",
      `Effect      ${action.effects.class} / risk ${action.effects.risk} / ${
        action.effects.reversible ? "reversible" : "irreversible"
      }`,
      `Confirm     ${action.effects.confirmation}${
        confirmationRequired(action.effects) ? "  (pass --yes)" : ""
      }`,
      `Timeout     ${action.execution.timeout_ms} ms`,
      ""
    ];
    const flags = describeFlags(action.input.jsonSchema);
    if (flags.length === 0) {
      lines.push("This Action takes no input.");
    } else {
      lines.push("Flags:");
      for (const flag of flags) {
        const requirement = flag.required ? "required" : "optional";
        const type = flag.boolean ? "" : ` <${typeLabel(flag.schema)}>`;
        lines.push(
          `  ${(flag.flag + type).padEnd(30)} ${requirement}${
            flag.description ? `  ${flag.description}` : ""
          }`
        );
      }
    }
    return lines.join("\n");
  }

  #list(json) {
    const actions = this.#registry.actionsForSurface(this.#surface).map((action) => ({
      id: action.id,
      title: action.title,
      description: action.description,
      effects: action.effects,
      confirmation_required: confirmationRequired(action.effects)
    }));
    if (json) {
      this.#out(stringify({ ok: true, actions }));
    } else {
      this.#out(actions.map((action) => `${action.id}\t${action.title}`).join("\n"));
    }
    return EXIT.ok;
  }

  #describe(actionId, json) {
    if (!actionId) return this.#usage("describe needs an Action ID.", json);
    const action = this.#registry.action(actionId);
    if (!action) return this.#unknownAction(actionId, json);
    if (json) {
      this.#out(
        stringify({
          ok: true,
          action: {
            id: action.id,
            title: action.title,
            description: action.description,
            tags: action.tags,
            input_schema: action.input.jsonSchema,
            output_schema: action.output.jsonSchema,
            effects: action.effects,
            execution: action.execution,
            confirmation_required: confirmationRequired(action.effects)
          }
        })
      );
    } else {
      this.#out(this.#actionHelp(actionId));
    }
    return EXIT.ok;
  }

  #export(section) {
    const bundle = this.#registry.artifactBundle();
    const payload =
      section === "manifest"
        ? bundle.manifest
        : section === "cli-help"
          ? bundle.cli_help
          : section === "mcp-tools"
            ? bundle.mcp_tools
            : bundle;
    this.#out(JSON.stringify(payload, null, 2));
    return EXIT.ok;
  }

  async #mcp() {
    const { serveMcpStdio } = await import("./mcp.mjs");
    await serveMcpStdio(this.#registry, { name: this.#name, version: this.#version });
    return EXIT.ok;
  }

  async #call(actionId, args, json) {
    if (!actionId) return this.#usage("An Action ID is required.", json);
    if (args.includes("--help") || args.includes("-h")) {
      this.#out(this.#actionHelp(actionId));
      return EXIT.ok;
    }

    const action = this.#registry.action(actionId);
    if (!action) return this.#unknownAction(actionId, json);
    if (!this.#registry.isExposed(actionId, this.#surface)) {
      return this.#usage(`${actionId} is not exposed on the ${this.#surface} Surface.`, json);
    }

    const confirmed = takeFlag(args, "--yes") || takeFlag(args, "-y");
    const executionId = takeOption(args, "--execution-id");
    const idempotencyKey = takeOption(args, "--idempotency-key");
    const expectedStateVersion = takeOption(args, "--expected-state-version");
    const inputJson = takeOption(args, "--input-json");

    if (inputJson !== null && hasWriteOnlyInput(action.input.jsonSchema)
      && inputJson !== "-" && !inputJson.startsWith("@")) {
      return this.#usage(
        "Secret input may only use --input-json - (stdin) or --input-json @file; inline argv is refused.",
        json
      );
    }

    let input = {};
    if (inputJson !== null) {
      const loaded = await this.#loadInputJson(inputJson);
      if (loaded.error) return this.#usage(loaded.error, json);
      input = loaded.value;
    }

    const parsed = parseFlags(action.input.jsonSchema, args);
    if (parsed.error) {
      return this.#usage(`${parsed.error}\n\n${this.#actionHelp(actionId)}`, json);
    }
    input = { ...input, ...parsed.value };

    const envelope = await this.#registry.dispatch({
      actionId,
      input,
      surface: this.#surface,
      confirmed,
      ...(executionId !== null ? { executionId } : {}),
      ...(idempotencyKey !== null ? { idempotencyKey } : {}),
      ...(expectedStateVersion !== null ? { expectedStateVersion } : {})
    });

    if (json) {
      this.#out(stringify(envelope));
      return envelope.ok ? EXIT.ok : CLASS_EXIT[envelope.error.class] ?? EXIT.error;
    }
    if (envelope.ok) {
      this.#out(renderResult(envelope.result, this.#stdout));
      return EXIT.ok;
    }
    this.#err(`${envelope.error.code}: ${envelope.error.message}`);
    if (envelope.error.code === "confirmation_required") {
      this.#err(`Re-run with --yes to confirm this ${envelope.error.details?.risk ?? "high"}-risk Action.`);
    }
    if (envelope.error.details?.issues) {
      for (const issue of envelope.error.details.issues) {
        this.#err(`  ${issue.path || "<input>"}: ${issue.message}`);
      }
    }
    return CLASS_EXIT[envelope.error.class] ?? EXIT.error;
  }

  async #loadInputJson(raw) {
    let text = raw;
    try {
      if (raw === "-") text = await readStream(this.#stdin);
      else if (raw.startsWith("@")) text = await readFile(raw.slice(1), "utf8");
      const value = JSON.parse(text);
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return { error: "--input-json must contain a JSON object." };
      }
      return { value };
    } catch (error) {
      return { error: `--input-json could not be read: ${error.message}` };
    }
  }

  #unknownAction(actionId, json) {
    const message = `Unknown Action ${actionId}. Run "${this.#name} list" to see the registered Actions.`;
    if (json) {
      this.#out(
        stringify({
          ok: false,
          version: 1,
          action_id: actionId,
          error: { class: "not_found", code: "unknown_action", message }
        })
      );
    } else {
      this.#err(message);
    }
    return EXIT.not_found;
  }

  #usage(message, json) {
    if (json) {
      this.#out(stringify({ ok: false, error: { class: "input", code: "usage", message } }));
    } else {
      this.#err(message);
    }
    return EXIT.usage;
  }

  #out(text) {
    if (text !== "") this.#stdout.write(`${text}\n`);
  }

  #err(text) {
    this.#stderr.write(`${text}\n`);
  }
}

function renderResult(result, stream) {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, stream?.isTTY ? 2 : 0);
}

function stringify(value) {
  return JSON.stringify(value);
}

function typeLabel(schema) {
  if (Array.isArray(schema?.enum)) return schema.enum.join("|");
  if (typeof schema?.type === "string") return schema.type;
  if (Array.isArray(schema?.type)) return schema.type.join("|");
  return "json";
}

function takeFlag(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function takeOption(args, flag) {
  const inline = args.findIndex((arg) => arg.startsWith(`${flag}=`));
  if (inline !== -1) {
    const [value] = args.splice(inline, 1);
    return value.slice(flag.length + 1);
  }
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  args.splice(index, value === undefined ? 1 : 2);
  return value ?? "";
}

/**
 * Build the input object from flags declared by the Action's input schema.
 * Unknown flags are a usage error rather than a silently dropped argument.
 */
export function parseFlags(schema, args) {
  const flags = describeFlags(schema);
  const byFlag = new Map();
  for (const flag of flags) {
    byFlag.set(flag.flag, flag);
    byFlag.set(`--${flag.name}`, flag);
  }

  const value = {};
  const positional = [];
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (!token.startsWith("-")) {
      positional.push(token);
      index += 1;
      continue;
    }

    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    const inlineValue = equals === -1 ? null : token.slice(equals + 1);

    if (RESERVED.has(name)) {
      return { error: `${name} is a reserved option and may only be given once.` };
    }

    const negated = name.startsWith("--no-") ? byFlag.get(`--${name.slice(5)}`) : null;
    if (negated?.boolean) {
      value[negated.name] = false;
      index += 1;
      continue;
    }

    const flag = byFlag.get(name);
    if (!flag) {
      const known = flags.map((entry) => entry.flag).join(", ") || "none";
      return { error: `Unknown flag ${name}. This Action accepts: ${known}.` };
    }

    if (flag.schema?.writeOnly === true) {
      return { error: `${flag.flag} is secret and may not be passed in argv; use --input-json - or @file.` };
    }

    if (flag.boolean && inlineValue === null) {
      value[flag.name] = true;
      index += 1;
      continue;
    }

    const raw = inlineValue ?? args[index + 1];
    if (raw === undefined || (inlineValue === null && raw.startsWith("--"))) {
      return { error: `${flag.flag} needs a value.` };
    }
    if (flag.repeatable) {
      // Repeat the flag to build an array: --tag a --tag b. A whole JSON array
      // still travels through --input-json, where its shape is unambiguous.
      const item = coerceStringValue(flag.schema.items ?? {}, raw, flag.schema);
      value[flag.name] = [...(value[flag.name] ?? []), item];
    } else {
      value[flag.name] = coerceStringValue(flag.schema, raw, flag.schema);
    }
    index += inlineValue === null ? 2 : 1;
  }

  if (positional.length > 0) {
    return { error: `Unexpected argument ${positional[0]}. Use flags or --input-json.` };
  }
  return { value };
}

function hasWriteOnlyInput(schema) {
  return Object.values(schema?.properties ?? {}).some((property) => property?.writeOnly === true);
}

async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}
