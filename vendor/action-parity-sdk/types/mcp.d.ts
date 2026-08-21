import type { ActionRegistry, EffectClass, Risk } from "./index.js";

export interface McpServerOptions {
  name?: string;
  version?: string;
  /** The Surface ID this server reports as. Defaults to "mcp". */
  surface?: string;
  instructions?: string;
}

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export declare class McpServer {
  constructor(registry: ActionRegistry, options?: McpServerOptions);
  /** Returns null for notifications, which must not receive a reply. */
  handle(message: unknown): Promise<JsonRpcMessage | null>;
  toolSummary(): Array<{
    name: string;
    confirmation_required: boolean;
    effect_class: EffectClass;
    risk: Risk;
  }>;
}

export declare function createMcpServer(
  registry: ActionRegistry,
  options?: McpServerOptions
): McpServer;

/** Serve newline-delimited JSON-RPC over stdio. stdout carries frames only. */
export declare function serveMcpStdio(
  registry: ActionRegistry,
  options?: McpServerOptions & {
    server?: McpServer;
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    log?: NodeJS.WritableStream;
  }
): Promise<void>;
