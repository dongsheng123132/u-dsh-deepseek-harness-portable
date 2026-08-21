/**
 * The Action Core for Node and Electron.
 *
 * A business Action is registered once here. Every Surface — Electron IPC, the
 * generated CLI, the MCP server, HTTP, tests — is a caller of `dispatch`, not a
 * second implementation. The same registry also emits the ActionParity
 * Manifest, the CLI catalog, and the MCP tool list, so the published contract
 * cannot drift away from the code that actually runs.
 */

import { ActionError, toActionError } from "./errors.mjs";
import { applyDefaults, isSchemaObject, s, validateValue } from "./schema.mjs";

export const SDK_VERSION = "0.7.0";
export const ENVELOPE_VERSION = 1;
export const MANIFEST_SPEC_VERSION = "0.5.0";
export const BUNDLE_FORMAT = "action-parity.registry-bundle/v1";
export const CLI_HELP_FORMAT = "action-parity.cli-help/v1";

const SURFACE_KINDS = new Set(["gui", "tui", "cli", "mcp", "api", "ipc", "test"]);
const REACHABILITY = new Set(["in-process", "local-ipc", "external"]);
const EFFECT_CLASSES = new Set(["read", "write", "external", "financial", "destructive"]);
const RISKS = new Set(["low", "medium", "high", "critical"]);
const CONFIRMATIONS = new Set(["never", "conditional", "always"]);
const DEFAULT_REACHABILITY = {
  gui: "in-process",
  tui: "in-process",
  cli: "external",
  mcp: "local-ipc",
  api: "external",
  ipc: "local-ipc",
  test: "in-process"
};

/** Effect defaults per class. A class alone is enough to declare an Action. */
const EFFECT_DEFAULTS = {
  read: { risk: "low", reversible: true, confirmation: "never", audit_required: false },
  write: { risk: "low", reversible: true, confirmation: "never", audit_required: true },
  external: { risk: "medium", reversible: false, confirmation: "conditional", audit_required: true },
  financial: { risk: "high", reversible: false, confirmation: "always", audit_required: true },
  destructive: { risk: "high", reversible: false, confirmation: "always", audit_required: true }
};

// Brands so `addSurface`/`register` can tell an already-normalized declaration
// from a raw literal. Shape-sniffing would silently accept a literal that is
// missing `requiredForParity` and publish a Manifest with a hole in it.
const SURFACE_BRAND = Symbol.for("action-parity.surface");
const ACTION_BRAND = Symbol.for("action-parity.action");

let executionCounter = 1;

/** Mirrors the Rust core so evidence reports read the same across languages. */
export function nextExecutionId() {
  const millis = Date.now().toString(16);
  const counter = (executionCounter++).toString(16);
  return `ap-${millis}-${counter}`;
}

export class RegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = "RegistryError";
  }
}

/** Declare a Shadow. `bindingTarget` must contain `{action_id}`. */
export function defineSurface(spec) {
  const id = requireString(spec?.id, "surface.id");
  if (!/^[a-z][a-z0-9._-]*$/.test(id)) {
    throw new RegistryError(`${id} is not a valid Surface ID.`);
  }
  const kind = requireString(spec?.kind, "surface.kind");
  if (!SURFACE_KINDS.has(kind)) {
    throw new RegistryError(`${id} declares unknown Surface kind ${kind}.`);
  }
  const reachability = spec.reachability ?? DEFAULT_REACHABILITY[kind];
  if (!REACHABILITY.has(reachability)) {
    throw new RegistryError(`${id} declares unknown reachability ${reachability}.`);
  }
  const bindingTarget = requireString(spec?.bindingTarget, "surface.bindingTarget");
  if (!bindingTarget.includes("{action_id}")) {
    throw new RegistryError(`${id} bindingTarget must contain {action_id}.`);
  }
  const requiredForParity = spec.requiredForParity ?? true;
  if (!requiredForParity && !isReason(spec.exclusionReason)) {
    throw new RegistryError(
      `${id} is not required for parity, so it needs an exclusionReason of at least 8 characters.`
    );
  }
  return Object.freeze({
    [SURFACE_BRAND]: true,
    id,
    kind,
    reachability,
    bindingTarget,
    bindingTest: optionalString(spec.bindingTest),
    description: optionalString(spec.description),
    testDriver: optionalString(spec.testDriver),
    requiredForParity,
    exclusionReason: optionalString(spec.exclusionReason)
  });
}

/**
 * Declare one business Action and its single implementation.
 *
 * Everything the other Surfaces need — schemas, risk, confirmation, timeout —
 * is stated here, so adding the second Surface adds no business code.
 */
export function defineAction(spec) {
  const id = requireString(spec?.id, "action.id");
  if (!/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/.test(id)) {
    throw new RegistryError(`${id} is not a stable dotted Action ID such as note.create.`);
  }
  const title = requireString(spec?.title, `${id}.title`);
  const description = requireString(spec?.description, `${id}.description`);
  if (typeof spec.handler !== "function") {
    throw new RegistryError(`${id} needs a handler function.`);
  }

  const input = normalizeSchemaSpec(spec.input, s.object({}), `${id}.input`);
  const output = normalizeSchemaSpec(spec.output, {}, `${id}.output`);
  const effects = normalizeEffects(spec.effects, id);
  const execution = normalizeExecution(spec.execution, id);
  const tags = normalizeTags(spec.tags, id);
  const surfaceIds = normalizeSurfaceIds(spec.surfaces, id);

  if (!isSchemaObject(input.jsonSchema) || !isSchemaObject(output.jsonSchema)) {
    throw new RegistryError(`${id} input and output schemas must be JSON Schema objects.`);
  }
  if (
    (effects.risk === "high" ||
      effects.risk === "critical" ||
      effects.class === "financial" ||
      effects.class === "destructive") &&
    effects.confirmation === "never"
  ) {
    throw new RegistryError(`${id} cannot disable confirmation for high-risk effects.`);
  }

  return Object.freeze({
    [ACTION_BRAND]: true,
    id,
    title,
    description,
    tags,
    input,
    output,
    effects,
    execution,
    surfaceIds,
    handler: spec.handler
  });
}

/** Create the Action Core. Surfaces and Actions may also be added later. */
export function createRegistry(options = {}) {
  return new ActionRegistry(options);
}

export class ActionRegistry {
  #application;
  #specVersion;
  #generatorRevision;
  #state;
  #surfaces = new Map();
  #actions = new Map();
  #authorize;
  #listeners = new Set();
  #stateVersion;
  #idempotency;
  #idempotencyStore = new Map();
  #validateOutput;
  #envelopeMeta;
  #cliInvocation;

  constructor(options = {}) {
    this.#application = normalizeApplication(options.application);
    this.#specVersion = options.specVersion ?? MANIFEST_SPEC_VERSION;
    this.#generatorRevision = optionalString(options.generatorRevision);
    this.#state = options.state ?? null;
    this.#authorize = options.authorize ?? null;
    this.#stateVersion = options.stateVersion ?? null;
    this.#idempotency = {
      max: options.idempotency?.max ?? 256,
      ttlMs: options.idempotency?.ttlMs ?? 10 * 60 * 1000
    };
    this.#validateOutput = options.validateOutput ?? true;
    this.#envelopeMeta = options.envelopeMeta === true;
    this.#cliInvocation =
      options.cli?.invocation ?? "call <action-id> --input-json <json> --json";
    if (typeof options.onEvent === "function") this.#listeners.add(options.onEvent);
    for (const surface of options.surfaces ?? []) this.addSurface(surface);
    for (const action of options.actions ?? []) this.register(action);
  }

  get application() {
    return { ...this.#application };
  }

  get specVersion() {
    return this.#specVersion;
  }

  /** Subscribe to lifecycle events. Returns an unsubscribe function. */
  on(listener) {
    if (typeof listener !== "function") throw new TypeError("on expects a function.");
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  addSurface(surface) {
    const declared = surface?.[SURFACE_BRAND] ? surface : defineSurface(surface);
    if (this.#surfaces.has(declared.id)) {
      throw new RegistryError(`duplicate Surface ID: ${declared.id}`);
    }
    if (declared.requiredForParity) {
      for (const action of this.#actions.values()) {
        if (action.surfaceIds && !action.surfaceIds.includes(declared.id)) {
          throw new RegistryError(
            `required Surface ${declared.id} is omitted by Action ${action.id}; expose the Action there or mark the Surface optional with an exclusionReason`
          );
        }
      }
    }
    this.#surfaces.set(declared.id, declared);
    return this;
  }

  register(action) {
    const declared = action?.[ACTION_BRAND] ? action : defineAction(action);
    if (this.#actions.has(declared.id)) {
      throw new RegistryError(`duplicate Action ID: ${declared.id}`);
    }
    if (declared.surfaceIds) {
      for (const surfaceId of declared.surfaceIds) {
        if (!this.#surfaces.has(surfaceId)) {
          throw new RegistryError(`${declared.id} names unknown Surface ${surfaceId}.`);
        }
      }
      for (const surface of this.#surfaces.values()) {
        if (surface.requiredForParity && !declared.surfaceIds.includes(surface.id)) {
          throw new RegistryError(
            `${declared.id} omits required Surface ${surface.id}; expose the Action there or mark the Surface optional with an exclusionReason`
          );
        }
      }
    }
    this.#actions.set(declared.id, declared);
    return this;
  }

  /** Register many Actions at once, keeping registration order irrelevant. */
  registerAll(actions) {
    for (const action of actions) this.register(action);
    return this;
  }

  action(id) {
    return this.#actions.get(id) ?? null;
  }

  actions() {
    return sortedById([...this.#actions.values()]);
  }

  surfaces() {
    return sortedById([...this.#surfaces.values()]);
  }

  /** Actions this Surface exposes, in Action ID order. */
  actionsForSurface(surfaceId) {
    return this.actions().filter((action) => exposedOn(action, surfaceId));
  }

  isExposed(actionId, surfaceId) {
    const action = this.#actions.get(actionId);
    return Boolean(action) && exposedOn(action, surfaceId);
  }

  /**
   * The single execution path. Every Surface calls this and nothing else.
   * It always resolves with an ExecutionEnvelope; it never rejects, so a
   * transport cannot accidentally leak a stack trace instead of an envelope.
   */
  async dispatch(request = {}) {
    const actionId = request.actionId ?? request.action_id ?? "";
    const executionId = request.executionId ?? request.execution_id ?? nextExecutionId();
    const surface = request.surface ?? null;
    const confirmed = request.confirmed === true;
    const startedAt = Date.now();

    const action = this.#actions.get(actionId);
    if (!action) {
      return this.#fail(actionId, executionId, surface, startedAt,
        ActionError.input("unknown_action", "The Action ID is not registered."));
    }

    if (surface !== null) {
      if (!this.#surfaces.has(surface)) {
        return this.#fail(actionId, executionId, surface, startedAt,
          ActionError.input("unknown_surface", "The Surface ID is not registered."));
      }
      if (!exposedOn(action, surface)) {
        return this.#fail(actionId, executionId, surface, startedAt,
          ActionError.input(
            "action_not_exposed_on_surface",
            "The Action is not exposed on the requested Surface."
          ));
      }
    }

    const expectedStateVersion =
      request.expectedStateVersion ?? request.expected_state_version ?? null;
    if (expectedStateVersion !== null && this.#stateVersion) {
      let actual;
      try {
        actual = await this.#stateVersion({ actionId, surface });
      } catch (error) {
        return this.#fail(actionId, executionId, surface, startedAt,
          ActionError.unavailable(
            "state_version_unavailable",
            "The authoritative state version could not be read.",
            { reason: toActionError(error).detail }
          ));
      }
      if (String(actual) !== String(expectedStateVersion)) {
        return this.#fail(actionId, executionId, surface, startedAt,
          ActionError.conflict(
            "state_version_conflict",
            "The caller acted on a stale state version; the Action was not executed.",
            { expected: expectedStateVersion, actual }
          ));
      }
    }

    if (this.#authorize) {
      let decision;
      try {
        decision = await this.#authorize({
          actionId,
          surface,
          action: describeAction(action),
          actor: request.actor ?? null,
          input: request.input ?? {},
          executionId
        });
      } catch (error) {
        return this.#fail(actionId, executionId, surface, startedAt, toActionError(error));
      }
      if (decision === false || decision?.allowed === false) {
        return this.#fail(actionId, executionId, surface, startedAt,
          ActionError.refused(
            decision?.code ?? "permission_denied",
            decision?.message ?? "The Action Core refused this caller.",
            decision?.details
          ));
      }
    }

    if (confirmationRequired(action.effects) && !confirmed) {
      return this.#fail(actionId, executionId, surface, startedAt,
        ActionError.refused(
          "confirmation_required",
          "The Action Core refused execution without explicit confirmation.",
          {
            risk: action.effects.risk,
            effect_class: action.effects.class,
            reversible: action.effects.reversible,
            retry_with: { confirmed: true }
          }
        ));
    }

    const idempotencyKey = request.idempotencyKey ?? request.idempotency_key ?? null;
    if (idempotencyKey !== null) {
      const replayed = this.#replay(actionId, idempotencyKey);
      if (replayed) {
        return this.#envelopeMeta
          ? { ...replayed, meta: { ...replayed.meta, replayed: true } }
          : replayed;
      }
    }

    const prepared = this.#prepareInput(action, request.input ?? {});
    if (!prepared.ok) {
      return this.#fail(actionId, executionId, surface, startedAt, prepared.error);
    }

    const controller = new AbortController();
    const external = request.signal ?? null;
    const onExternalAbort = () => controller.abort(external?.reason);
    if (external) {
      if (external.aborted) controller.abort(external.reason);
      else external.addEventListener("abort", onExternalAbort, { once: true });
    }

    const context = {
      executionId,
      actionId,
      surface,
      confirmed,
      actor: request.actor ?? null,
      meta: request.meta ?? {},
      signal: controller.signal,
      deadline: startedAt + action.execution.timeout_ms,
      registry: this,
      emit: (event) => this.#emit({ ...event, action_id: actionId, execution_id: executionId })
    };

    this.#emit({
      type: "action.started",
      action_id: actionId,
      execution_id: executionId,
      surface,
      effect_class: action.effects.class,
      risk: action.effects.risk,
      audit_required: action.effects.audit_required,
      at: startedAt
    });

    let timer = null;
    try {
      const work = Promise.resolve().then(() => action.handler(prepared.value, context));
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error("action_timed_out"));
          reject(
            ActionError.timeout("action_timed_out", "The Action exceeded its declared timeout.", {
              timeout_ms: action.execution.timeout_ms
            })
          );
        }, action.execution.timeout_ms);
        if (typeof timer.unref === "function") timer.unref();
      });
      const result = await Promise.race([work, timeout]);
      const normalized = result === undefined ? null : result;

      if (this.#validateOutput) {
        const report = validateValue(action.output.jsonSchema, normalized);
        if (!report.ok) {
          return this.#fail(actionId, executionId, surface, startedAt,
            ActionError.internal(
              "output_validation_failed",
              "The Action result does not match its declared output schema.",
              { issues: report.issues.slice(0, 20) }
            ));
        }
      }

      const envelope = this.#succeed(actionId, executionId, surface, startedAt, normalized);
      if (idempotencyKey !== null) this.#remember(actionId, idempotencyKey, envelope);
      return envelope;
    } catch (error) {
      return this.#fail(actionId, executionId, surface, startedAt, toActionError(error));
    } finally {
      if (timer) clearTimeout(timer);
      if (external) external.removeEventListener("abort", onExternalAbort);
    }
  }

  /**
   * A caller bound to one Surface. Transports use this so they cannot forget
   * to declare which Shadow they are.
   */
  clientFor(surfaceId, defaults = {}) {
    if (!this.#surfaces.has(surfaceId)) {
      throw new RegistryError(`unknown Surface ${surfaceId}.`);
    }
    return (actionId, input, overrides = {}) =>
      this.dispatch({ ...defaults, ...overrides, actionId, input, surface: surfaceId });
  }

  /** Deterministic ActionParity Manifest derived from the running registry. */
  manifest() {
    const generatedFrom = { generator: `action-parity-sdk/${SDK_VERSION}` };
    if (this.#generatorRevision) generatedFrom.revision = this.#generatorRevision;

    const manifest = {
      $schema: `https://raw.githubusercontent.com/dongsheng123132/action-parity/v${this.#specVersion}/schema/action-parity.schema.json`,
      spec_version: this.#specVersion,
      application: this.#application,
      surfaces: this.surfaces().map(manifestSurface),
      actions: this.actions().map((action) => this.#manifestAction(action)),
      generated_from: generatedFrom
    };
    if (this.#state) manifest.state = this.#state;
    return manifest;
  }

  /** Machine-readable catalog for a generic CLI. */
  cliHelp() {
    return {
      format: CLI_HELP_FORMAT,
      application: this.#application,
      invocation: this.#cliInvocation,
      actions: this.#actionsForKind("cli").map((action) => ({
        id: action.id,
        title: action.title,
        description: action.description,
        input_schema: action.input.jsonSchema,
        output_schema: action.output.jsonSchema,
        effects: action.effects
      }))
    };
  }

  /** MCP `tools/list` payload. The transport only forwards to dispatch. */
  mcpTools() {
    return {
      tools: this.#actionsForKind("mcp").map((action) => ({
        name: action.id,
        title: action.title,
        description: action.description,
        inputSchema: action.input.jsonSchema,
        outputSchema: action.output.jsonSchema
      }))
    };
  }

  /** The one artifact `action-parity generate` consumes. */
  artifactBundle() {
    return {
      format: BUNDLE_FORMAT,
      manifest: this.manifest(),
      cli_help: this.cliHelp(),
      mcp_tools: this.mcpTools()
    };
  }

  #actionsForKind(kind) {
    const surfaceIds = this.surfaces()
      .filter((surface) => surface.kind === kind)
      .map((surface) => surface.id);
    return this.actions().filter((action) =>
      surfaceIds.some((surfaceId) => exposedOn(action, surfaceId))
    );
  }

  #manifestAction(action) {
    const value = {
      id: action.id,
      title: action.title,
      description: action.description,
      input_schema: action.input.jsonSchema,
      output_schema: action.output.jsonSchema,
      effects: action.effects,
      execution: action.execution,
      bindings: this.surfaces()
        .filter((surface) => exposedOn(action, surface.id))
        .map((surface) => {
          const binding = {
            surface: surface.id,
            target: expandTemplate(surface.bindingTarget, action)
          };
          if (surface.bindingTest) binding.test = expandTemplate(surface.bindingTest, action);
          return binding;
        })
    };
    if (action.tags.length > 0) value.tags = action.tags;
    return value;
  }

  #prepareInput(action, rawInput) {
    const schema = action.input.jsonSchema;
    let value = rawInput;
    if (value === undefined || value === null) value = {};
    value = applyDefaults(schema, value);

    if (action.input.parse) {
      let parsed;
      try {
        parsed = action.input.parse(value);
      } catch (error) {
        return {
          ok: false,
          error: ActionError.input(
            "input_validation_failed",
            "Input does not match the registered Action schema.",
            { reason: toActionError(error).detail }
          )
        };
      }
      if (parsed?.ok === false) {
        return {
          ok: false,
          error: ActionError.input(
            "input_validation_failed",
            "Input does not match the registered Action schema.",
            { issues: (parsed.issues ?? []).slice(0, 20) }
          )
        };
      }
      return { ok: true, value: parsed?.ok === true ? parsed.value : parsed };
    }

    const report = validateValue(schema, value);
    if (!report.ok) {
      return {
        ok: false,
        error: ActionError.input(
          "input_validation_failed",
          "Input does not match the registered Action schema.",
          { issues: report.issues.slice(0, 20) }
        )
      };
    }
    return { ok: true, value };
  }

  #succeed(actionId, executionId, surface, startedAt, result) {
    const envelope = {
      ok: true,
      version: ENVELOPE_VERSION,
      action_id: actionId,
      execution_id: executionId,
      result
    };
    if (this.#envelopeMeta) {
      envelope.meta = { surface, duration_ms: Date.now() - startedAt, replayed: false };
    }
    this.#emit({
      type: "action.succeeded",
      action_id: actionId,
      execution_id: executionId,
      surface,
      duration_ms: Date.now() - startedAt
    });
    return envelope;
  }

  #fail(actionId, executionId, surface, startedAt, error) {
    const envelope = {
      ok: false,
      version: ENVELOPE_VERSION,
      action_id: actionId,
      execution_id: executionId,
      error: error.toJSON()
    };
    if (this.#envelopeMeta) {
      envelope.meta = { surface, duration_ms: Date.now() - startedAt, replayed: false };
    }
    this.#emit({
      type: "action.failed",
      action_id: actionId,
      execution_id: executionId,
      surface,
      error_class: error.class,
      error_code: error.code,
      duration_ms: Date.now() - startedAt
    });
    return envelope;
  }

  #emit(event) {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // An observer must never change the outcome of a business Action.
      }
    }
  }

  #replay(actionId, key) {
    const entry = this.#idempotencyStore.get(`${actionId} ${key}`);
    if (!entry) return null;
    if (Date.now() - entry.at > this.#idempotency.ttlMs) {
      this.#idempotencyStore.delete(`${actionId} ${key}`);
      return null;
    }
    return entry.envelope;
  }

  #remember(actionId, key, envelope) {
    const storeKey = `${actionId} ${key}`;
    this.#idempotencyStore.delete(storeKey);
    this.#idempotencyStore.set(storeKey, { at: Date.now(), envelope });
    while (this.#idempotencyStore.size > this.#idempotency.max) {
      const oldest = this.#idempotencyStore.keys().next().value;
      this.#idempotencyStore.delete(oldest);
    }
  }
}

/** True when the Action Core must see an explicit confirmation. */
export function confirmationRequired(effects) {
  if (effects.confirmation === "always") return true;
  return (
    effects.confirmation === "conditional" &&
    (effects.risk === "high" ||
      effects.risk === "critical" ||
      effects.class === "financial" ||
      effects.class === "destructive")
  );
}

export function exposedOn(action, surfaceId) {
  return action.surfaceIds === null || action.surfaceIds.includes(surfaceId);
}

function describeAction(action) {
  return {
    id: action.id,
    title: action.title,
    effects: action.effects,
    execution: action.execution
  };
}

function manifestSurface(surface) {
  const value = {
    id: surface.id,
    kind: surface.kind,
    required_for_parity: surface.requiredForParity,
    reachability: surface.reachability
  };
  if (surface.description) value.description = surface.description;
  if (surface.testDriver) value.test_driver = surface.testDriver;
  if (surface.exclusionReason) value.exclusion_reason = surface.exclusionReason;
  return value;
}

function expandTemplate(template, action) {
  return template.replaceAll("{action_id}", action.id).replaceAll("{action_title}", action.title);
}

function sortedById(values) {
  return [...values].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function normalizeApplication(application) {
  const id = requireString(application?.id, "application.id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(id)) {
    throw new RegistryError(`${id} is not a valid application ID.`);
  }
  const value = {
    id,
    name: requireString(application?.name, "application.name"),
    version: requireString(application?.version, "application.version")
  };
  if (application.description) value.description = String(application.description);
  if (application.homepage) value.homepage = requireHttps(application.homepage, "homepage");
  if (application.source) value.source = requireHttps(application.source, "source");
  return value;
}

function normalizeEffects(effects, id) {
  const raw = typeof effects === "string" ? { class: effects } : effects;
  if (!raw || typeof raw !== "object") {
    throw new RegistryError(`${id} needs an effects declaration such as "write".`);
  }
  const effectClass = raw.class ?? raw.effectClass;
  if (!EFFECT_CLASSES.has(effectClass)) {
    throw new RegistryError(
      `${id} declares unknown effect class ${effectClass}; expected one of ${[...EFFECT_CLASSES].join(", ")}.`
    );
  }
  const defaults = EFFECT_DEFAULTS[effectClass];
  const value = {
    class: effectClass,
    risk: raw.risk ?? defaults.risk,
    reversible: raw.reversible ?? defaults.reversible,
    confirmation: raw.confirmation ?? defaults.confirmation,
    audit_required: raw.audit_required ?? raw.auditRequired ?? defaults.audit_required
  };
  if (!RISKS.has(value.risk)) throw new RegistryError(`${id} declares unknown risk ${value.risk}.`);
  if (!CONFIRMATIONS.has(value.confirmation)) {
    throw new RegistryError(`${id} declares unknown confirmation ${value.confirmation}.`);
  }
  if (typeof value.reversible !== "boolean" || typeof value.audit_required !== "boolean") {
    throw new RegistryError(`${id} reversible and audit_required must be booleans.`);
  }
  const rollback = raw.rollback_action ?? raw.rollbackAction;
  if (rollback) value.rollback_action = String(rollback);
  if (raw.notes) value.notes = String(raw.notes);
  return Object.freeze(value);
}

function normalizeExecution(execution, id) {
  const raw = execution ?? {};
  const value = {
    headless: raw.headless ?? true,
    idempotent: raw.idempotent ?? false,
    cancellable: raw.cancellable ?? false,
    timeout_ms: raw.timeout_ms ?? raw.timeoutMs ?? 30_000
  };
  if (value.headless !== true) {
    throw new RegistryError(`${id} is a business Action and must be headless.`);
  }
  if (!Number.isInteger(value.timeout_ms) || value.timeout_ms < 1 || value.timeout_ms > 86_400_000) {
    throw new RegistryError(`${id} timeout_ms must be an integer within 1..86400000.`);
  }
  const progress = raw.progress_events ?? raw.progressEvents;
  if (progress !== undefined) value.progress_events = Boolean(progress);
  const evidence = raw.headless_evidence ?? raw.headlessEvidence ?? raw.evidence;
  if (evidence) value.headless_evidence = String(evidence);
  return Object.freeze(value);
}

function normalizeTags(tags, id) {
  if (tags === undefined) return Object.freeze([]);
  if (!Array.isArray(tags)) throw new RegistryError(`${id} tags must be an array of strings.`);
  const unique = [...new Set(tags.map((tag) => requireString(tag, `${id}.tags`)))];
  return Object.freeze(unique);
}

function normalizeSurfaceIds(surfaces, id) {
  if (surfaces === undefined || surfaces === null) return null;
  if (!Array.isArray(surfaces) || surfaces.length === 0) {
    throw new RegistryError(`${id} must be exposed on at least one Surface.`);
  }
  return Object.freeze([...new Set(surfaces.map((surface) => requireString(surface, `${id}.surfaces`)))]);
}

function normalizeSchemaSpec(spec, fallback, label) {
  if (spec === undefined || spec === null) return { jsonSchema: fallback, parse: null };
  if (typeof spec.parse === "function" && isSchemaObject(spec.jsonSchema)) {
    return { jsonSchema: spec.jsonSchema, parse: spec.parse };
  }
  if (isSchemaObject(spec.jsonSchema)) return { jsonSchema: spec.jsonSchema, parse: null };
  if (isSchemaObject(spec)) {
    if (spec["~standard"]) {
      throw new RegistryError(
        `${label} received a Standard Schema validator directly. Wrap it with fromStandardSchema(validator, jsonSchema) so the published contract stays explicit.`
      );
    }
    return { jsonSchema: spec, parse: null };
  }
  throw new RegistryError(`${label} must be a JSON Schema object.`);
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RegistryError(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireHttps(value, label) {
  const text = String(value);
  if (!text.startsWith("https://")) throw new RegistryError(`${label} must start with https://.`);
  return text;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function isReason(value) {
  return typeof value === "string" && value.trim().length >= 8;
}
