/**
 * Type declarations for action-parity-sdk.
 *
 * The runtime is plain ESM with no build step; these declarations describe it
 * so a TypeScript Electron or Node application gets the Action Core, the
 * envelope, and the context typed without compiling the SDK itself.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonSchema = Record<string, unknown>;

export type SurfaceKind = "gui" | "tui" | "cli" | "mcp" | "api" | "ipc" | "test";
export type Reachability = "in-process" | "local-ipc" | "external";
export type EffectClass = "read" | "write" | "external" | "financial" | "destructive";
export type Risk = "low" | "medium" | "high" | "critical";
export type ConfirmationPolicy = "never" | "conditional" | "always";
export type ErrorClass =
  | "input"
  | "refused"
  | "not_found"
  | "conflict"
  | "timeout"
  | "unavailable"
  | "internal";

export declare const ERROR_CLASSES: readonly ErrorClass[];
export declare const SDK_VERSION: string;
export declare const ENVELOPE_VERSION: 1;
export declare const MANIFEST_SPEC_VERSION: string;
export declare const BUNDLE_FORMAT: "action-parity.registry-bundle/v1";
export declare const CLI_HELP_FORMAT: "action-parity.cli-help/v1";

export interface ActionErrorPayload {
  class: ErrorClass;
  code: string;
  message: string;
  details?: JsonValue;
}

export declare class ActionError extends Error {
  constructor(errorClass: ErrorClass, code: string, message: string, details?: JsonValue);
  readonly class: ErrorClass;
  readonly code: string;
  /** The human-readable message without the `code:` prefix. */
  readonly detail: string;
  readonly details?: JsonValue;
  toJSON(): ActionErrorPayload;
  withDetails(details: JsonValue): ActionError;
  static input(code: string, message: string, details?: JsonValue): ActionError;
  static refused(code: string, message: string, details?: JsonValue): ActionError;
  static notFound(code: string, message: string, details?: JsonValue): ActionError;
  static conflict(code: string, message: string, details?: JsonValue): ActionError;
  static timeout(code: string, message: string, details?: JsonValue): ActionError;
  static unavailable(code: string, message: string, details?: JsonValue): ActionError;
  static internal(code: string, message: string, details?: JsonValue): ActionError;
  static isActionError(value: unknown): value is ActionError;
}

export declare function toActionError(thrown: unknown): ActionError;

export declare class RegistryError extends Error {}

/** The success/failure envelope every Surface receives, unchanged. */
export type ExecutionEnvelope<TResult = unknown> =
  | {
      ok: true;
      version: 1;
      action_id: string;
      execution_id: string;
      result: TResult;
      meta?: EnvelopeMeta;
    }
  | {
      ok: false;
      version: 1;
      action_id: string;
      execution_id: string;
      error: ActionErrorPayload;
      meta?: EnvelopeMeta;
    };

export interface EnvelopeMeta {
  surface: string | null;
  duration_ms: number;
  replayed: boolean;
}

export interface Effects {
  class: EffectClass;
  risk: Risk;
  reversible: boolean;
  confirmation: ConfirmationPolicy;
  audit_required: boolean;
  rollback_action?: string;
  notes?: string;
}

export interface EffectsInput {
  class: EffectClass;
  risk?: Risk;
  reversible?: boolean;
  confirmation?: ConfirmationPolicy;
  audit_required?: boolean;
  auditRequired?: boolean;
  rollback_action?: string;
  rollbackAction?: string;
  notes?: string;
}

export interface Execution {
  headless: boolean;
  idempotent: boolean;
  cancellable: boolean;
  timeout_ms: number;
  progress_events?: boolean;
  headless_evidence?: string;
}

export interface ExecutionInput {
  headless?: true;
  idempotent?: boolean;
  cancellable?: boolean;
  timeout_ms?: number;
  timeoutMs?: number;
  progress_events?: boolean;
  progressEvents?: boolean;
  headless_evidence?: string;
  headlessEvidence?: string;
  evidence?: string;
}

export interface SurfaceInput {
  id: string;
  kind: SurfaceKind;
  /** Must contain `{action_id}`; `{action_title}` is also expanded. */
  bindingTarget: string;
  bindingTest?: string;
  reachability?: Reachability;
  requiredForParity?: boolean;
  /** Required, and at least 8 characters, when requiredForParity is false. */
  exclusionReason?: string;
  description?: string;
  testDriver?: string;
}

export interface Surface {
  readonly id: string;
  readonly kind: SurfaceKind;
  readonly reachability: Reachability;
  readonly bindingTarget: string;
  readonly bindingTest: string | null;
  readonly description: string | null;
  readonly testDriver: string | null;
  readonly requiredForParity: boolean;
  readonly exclusionReason: string | null;
}

/** A validator paired with the JSON Schema that is actually published. */
export interface SchemaSpec<T = unknown> {
  jsonSchema: JsonSchema;
  parse?: (value: unknown) => T | { ok: true; value: T } | { ok: false; issues: SchemaIssue[] };
}

export interface SchemaIssue {
  path: string;
  message: string;
}

export interface ActionContext {
  readonly executionId: string;
  readonly actionId: string;
  readonly surface: string | null;
  readonly confirmed: boolean;
  readonly actor: unknown;
  readonly meta: Record<string, unknown>;
  readonly signal: AbortSignal;
  /** Epoch milliseconds after which the declared timeout fires. */
  readonly deadline: number;
  readonly registry: ActionRegistry;
  emit(event: Record<string, unknown>): void;
}

export interface ActionSpec<TInput = Record<string, unknown>, TOutput = unknown> {
  id: string;
  title: string;
  description: string;
  effects: EffectClass | EffectsInput;
  handler: (input: TInput, context: ActionContext) => TOutput | Promise<TOutput>;
  input?: JsonSchema | SchemaSpec<TInput>;
  output?: JsonSchema | SchemaSpec<TOutput>;
  execution?: ExecutionInput;
  tags?: string[];
  /** Omit to expose the Action on every registered Surface. */
  surfaces?: string[];
}

export interface ActionDefinition<TInput = Record<string, unknown>, TOutput = unknown> {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly input: { jsonSchema: JsonSchema; parse: SchemaSpec<TInput>["parse"] | null };
  readonly output: { jsonSchema: JsonSchema; parse: SchemaSpec<TOutput>["parse"] | null };
  readonly effects: Effects;
  readonly execution: Execution;
  readonly surfaceIds: readonly string[] | null;
  readonly handler: (input: TInput, context: ActionContext) => TOutput | Promise<TOutput>;
}

export interface Application {
  id: string;
  name: string;
  version: string;
  description?: string;
  homepage?: string;
  source?: string;
}

export interface DispatchRequest {
  actionId?: string;
  action_id?: string;
  input?: unknown;
  surface?: string | null;
  confirmed?: boolean;
  executionId?: string;
  execution_id?: string;
  idempotencyKey?: string;
  idempotency_key?: string;
  expectedStateVersion?: string | number;
  expected_state_version?: string | number;
  actor?: unknown;
  meta?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface AuthorizeRequest {
  actionId: string;
  surface: string | null;
  action: { id: string; title: string; effects: Effects; execution: Execution };
  actor: unknown;
  input: unknown;
  executionId: string;
}

export type AuthorizeDecision =
  | boolean
  | { allowed: boolean; code?: string; message?: string; details?: JsonValue };

export interface RegistryEvent {
  type: "action.started" | "action.succeeded" | "action.failed" | (string & {});
  action_id: string;
  execution_id: string;
  surface?: string | null;
  [key: string]: unknown;
}

export interface RegistryOptions {
  application: Application;
  surfaces?: (Surface | SurfaceInput)[];
  actions?: ActionDefinition<never, never>[] | ActionSpec<never, never>[];
  specVersion?: string;
  /** Recorded in `generated_from.revision`; normally the authoring file path. */
  generatorRevision?: string;
  state?: JsonValue;
  /** Enforced below every Surface, before the handler runs. */
  authorize?: (request: AuthorizeRequest) => AuthorizeDecision | Promise<AuthorizeDecision>;
  onEvent?: (event: RegistryEvent) => void;
  /** Authoritative state version used to reject stale writes. */
  stateVersion?: (context: { actionId: string; surface: string | null }) =>
    | string
    | number
    | Promise<string | number>;
  idempotency?: { max?: number; ttlMs?: number };
  /** Default true: a result that violates its declared schema is an error. */
  validateOutput?: boolean;
  /** Adds a non-normative `meta` field to every envelope. */
  envelopeMeta?: boolean;
  cli?: { invocation?: string };
}

export declare class ActionRegistry {
  constructor(options: RegistryOptions);
  readonly application: Application;
  readonly specVersion: string;
  on(listener: (event: RegistryEvent) => void): () => void;
  addSurface(surface: Surface | SurfaceInput): this;
  register<TInput, TOutput>(
    action: ActionDefinition<TInput, TOutput> | ActionSpec<TInput, TOutput>
  ): this;
  registerAll(actions: (ActionDefinition<never, never> | ActionSpec<never, never>)[]): this;
  action(id: string): ActionDefinition | null;
  actions(): ActionDefinition[];
  surfaces(): Surface[];
  actionsForSurface(surfaceId: string): ActionDefinition[];
  isExposed(actionId: string, surfaceId: string): boolean;
  dispatch<TResult = unknown>(request: DispatchRequest): Promise<ExecutionEnvelope<TResult>>;
  clientFor(
    surfaceId: string,
    defaults?: Partial<DispatchRequest>
  ): <TResult = unknown>(
    actionId: string,
    input?: unknown,
    overrides?: Partial<DispatchRequest>
  ) => Promise<ExecutionEnvelope<TResult>>;
  manifest(): Record<string, JsonValue>;
  cliHelp(): Record<string, JsonValue>;
  mcpTools(): { tools: Array<Record<string, JsonValue>> };
  artifactBundle(): {
    format: "action-parity.registry-bundle/v1";
    manifest: Record<string, JsonValue>;
    cli_help: Record<string, JsonValue>;
    mcp_tools: { tools: Array<Record<string, JsonValue>> };
  };
}

export declare function createRegistry(options: RegistryOptions): ActionRegistry;
export declare function defineAction<TInput = Record<string, unknown>, TOutput = unknown>(
  spec: ActionSpec<TInput, TOutput>
): ActionDefinition<TInput, TOutput>;
export declare function defineSurface(spec: SurfaceInput): Surface;
export declare function confirmationRequired(effects: Effects): boolean;
export declare function exposedOn(action: ActionDefinition, surfaceId: string): boolean;
export declare function nextExecutionId(): string;

export declare function validateValue(
  schema: JsonSchema,
  value: unknown,
  options?: { root?: JsonSchema }
): { ok: boolean; issues: SchemaIssue[] };
export declare function applyDefaults<T>(schema: JsonSchema, value: T, root?: JsonSchema): T;
export declare function coerceStringValue(
  schema: JsonSchema,
  raw: string,
  root?: JsonSchema
): JsonValue;
export declare function isSchemaObject(value: unknown): value is JsonSchema;

export interface FlagDescription {
  name: string;
  flag: string;
  required: boolean;
  boolean: boolean;
  repeatable: boolean;
  description: string;
  schema: JsonSchema;
  default?: unknown;
}

export declare function describeFlags(schema: JsonSchema, root?: JsonSchema): FlagDescription[];
export declare function flagToProperty(
  schema: JsonSchema,
  flag: string,
  root?: JsonSchema
): FlagDescription | null;

/** Adapt Zod 4, Valibot, or ArkType while publishing an explicit JSON Schema. */
export declare function fromStandardSchema<T>(
  validator: { "~standard": { validate(value: unknown): unknown } },
  jsonSchema: JsonSchema
): SchemaSpec<T>;

export interface SchemaBuilderOptions {
  title?: string;
  description?: string;
  default?: JsonValue;
  examples?: JsonValue[];
  deprecated?: boolean;
  [key: string]: unknown;
}

/** A minimal JSON Schema builder. Every helper returns plain JSON Schema. */
export declare const s: {
  object(
    properties?: Record<string, JsonSchema>,
    options?: SchemaBuilderOptions & { additionalProperties?: boolean | JsonSchema }
  ): JsonSchema;
  string(options?: SchemaBuilderOptions & {
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    format?: string;
    enum?: string[];
  }): JsonSchema;
  number(options?: SchemaBuilderOptions & { minimum?: number; maximum?: number }): JsonSchema;
  integer(options?: SchemaBuilderOptions & { minimum?: number; maximum?: number }): JsonSchema;
  boolean(options?: SchemaBuilderOptions): JsonSchema;
  array(
    items: JsonSchema,
    options?: SchemaBuilderOptions & { minItems?: number; maxItems?: number; uniqueItems?: boolean }
  ): JsonSchema;
  enum(values: readonly JsonValue[], options?: SchemaBuilderOptions): JsonSchema;
  literal(value: JsonValue, options?: SchemaBuilderOptions): JsonSchema;
  record(valueSchema: JsonSchema, options?: SchemaBuilderOptions): JsonSchema;
  union(variants: JsonSchema[], options?: SchemaBuilderOptions): JsonSchema;
  nullable(schema: JsonSchema, options?: SchemaBuilderOptions): JsonSchema;
  any(options?: SchemaBuilderOptions): JsonSchema;
  optional(schema: JsonSchema): JsonSchema;
};
