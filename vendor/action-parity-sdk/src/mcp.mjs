/**
 * The MCP Shadow.
 *
 * A Model Context Protocol server over stdio that forwards every `tools/call`
 * to `registry.dispatch`. It reimplements no Action. The advertised tool list
 * is exactly `registry.mcpTools()`, which is also what
 * `action-parity generate` writes to `mcp-tools.json`, so an agent and the
 * generated artifact can never disagree about what this server exposes.
 *
 * Confirmation stays in the Action Core. A high-risk Action returns a
 * `confirmation_required` tool error carrying `retry_with`, so the agent must
 * go back to its human before the write happens; it cannot be bypassed by
 * calling the tool differently.
 */

import process from "node:process";
import { confirmationRequired } from "./registry.mjs";

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
const CONFIRM_META = "actionparity/confirmed";
const EXECUTION_META = "actionparity/execution_id";
const IDEMPOTENCY_META = "actionparity/idempotency_key";
const STATE_VERSION_META = "actionparity/expected_state_version";

export function createMcpServer(registry, options = {}) {
  return new McpServer(registry, options);
}

export class McpServer {
  #registry;
  #name;
  #version;
  #surface;
  #instructions;

  constructor(registry, options = {}) {
    this.#registry = registry;
    this.#name = options.name ?? registry.application.id;
    this.#version = options.version ?? registry.application.version;
    this.#surface = options.surface ?? "mcp";
    this.#instructions =
      options.instructions ??
      [
        `${registry.application.name} exposes business Actions through one Action Core.`,
        "Every tool returns an ExecutionEnvelope with a stable ok field and, on failure,",
        "an error object with class and code. When an Action answers",
        "confirmation_required, ask the human, then retry with",
        `_meta: { "${CONFIRM_META}": true }.`
      ].join(" ");
  }

  /**
   * Handle one decoded JSON-RPC message. Returns the response object, or null
   * for notifications, which must not receive a reply.
   */
  async handle(message) {
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
      return errorResponse(message?.id ?? null, -32600, "Invalid JSON-RPC 2.0 request.");
    }
    const isNotification = message.id === undefined || message.id === null;
    if (typeof message.method !== "string") {
      return isNotification ? null : errorResponse(message.id, -32600, "A method is required.");
    }

    switch (message.method) {
      case "initialize":
        return result(message.id, this.#initialize(message.params));
      case "notifications/initialized":
      case "notifications/cancelled":
      case "notifications/progress":
        return null;
      case "ping":
        return result(message.id, {});
      case "tools/list":
        return result(message.id, this.#registry.mcpTools());
      case "tools/call":
        return result(message.id, await this.#callTool(message.params));
      default:
        if (isNotification) return null;
        return errorResponse(message.id, -32601, `Unknown method ${message.method}.`);
    }
  }

  #initialize(params) {
    const requested = params?.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : DEFAULT_PROTOCOL_VERSION;
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: this.#name, version: this.#version },
      instructions: this.#instructions
    };
  }

  async #callTool(params) {
    const name = params?.name;
    const action = typeof name === "string" ? this.#registry.action(name) : null;
    if (!action || !this.#registry.isExposed(name, this.#surface)) {
      throw new RpcError(-32602, `Unknown tool ${name}.`);
    }

    const meta = params?._meta ?? {};
    const rawArguments = params?.arguments ?? {};
    const { __confirm: inlineConfirm, ...input } =
      rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)
        ? rawArguments
        : {};

    const envelope = await this.#registry.dispatch({
      actionId: name,
      input,
      surface: this.#surface,
      confirmed: meta[CONFIRM_META] === true || inlineConfirm === true,
      ...(typeof meta[EXECUTION_META] === "string" ? { executionId: meta[EXECUTION_META] } : {}),
      ...(typeof meta[IDEMPOTENCY_META] === "string"
        ? { idempotencyKey: meta[IDEMPOTENCY_META] }
        : {}),
      ...(meta[STATE_VERSION_META] !== undefined
        ? { expectedStateVersion: meta[STATE_VERSION_META] }
        : {})
    });

    const payload = {
      content: [{ type: "text", text: JSON.stringify(envelope) }],
      isError: !envelope.ok,
      _meta: { [EXECUTION_META]: envelope.execution_id }
    };
    if (envelope.ok && envelope.result !== null && typeof envelope.result === "object") {
      payload.structuredContent = envelope.result;
    }
    if (!envelope.ok && envelope.error.code === "confirmation_required") {
      payload.content.push({
        type: "text",
        text: `${action.title} is a ${action.effects.risk}-risk ${action.effects.class} Action. Ask the human, then retry with _meta {"${CONFIRM_META}": true}.`
      });
    }
    return payload;
  }

  /** The tools an agent will see, with the confirmation requirement spelled out. */
  toolSummary() {
    return this.#registry.actionsForSurface(this.#surface).map((action) => ({
      name: action.id,
      confirmation_required: confirmationRequired(action.effects),
      effect_class: action.effects.class,
      risk: action.effects.risk
    }));
  }
}

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function result(id, value) {
  return { jsonrpc: "2.0", id, result: value };
}

function errorResponse(id, code, message, data) {
  const payload = { jsonrpc: "2.0", id, error: { code, message } };
  if (data !== undefined) payload.error.data = data;
  return payload;
}

/**
 * Serve MCP over newline-delimited JSON on stdio.
 *
 * stdout carries protocol frames only. Anything a human should read goes to
 * stderr, because one stray console.log on stdout corrupts the session.
 */
export function serveMcpStdio(registry, options = {}) {
  const server = options.server ?? createMcpServer(registry, options);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const log = options.log ?? process.stderr;

  return new Promise((resolve, reject) => {
    let buffer = "";
    let queue = Promise.resolve();

    const write = (message) => {
      if (message !== null) output.write(`${JSON.stringify(message)}\n`);
    };

    const enqueue = (line) => {
      queue = queue.then(async () => {
        let message = null;
        try {
          message = JSON.parse(line);
        } catch {
          write(errorResponse(null, -32700, "Invalid JSON."));
          return;
        }
        try {
          write(await server.handle(message));
        } catch (error) {
          if (message?.id === undefined || message?.id === null) {
            log.write(`action-parity mcp: ${error.message}\n`);
            return;
          }
          write(
            error instanceof RpcError
              ? errorResponse(message.id, error.code, error.message, error.data)
              : errorResponse(message.id, -32603, error.message ?? "Internal server error.")
          );
        }
      });
    };

    input.setEncoding?.("utf8");
    input.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line !== "") enqueue(line);
        newline = buffer.indexOf("\n");
      }
    });
    input.on("error", reject);
    input.on("end", () => {
      queue.then(resolve, reject);
    });
  });
}
