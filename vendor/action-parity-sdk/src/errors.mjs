/**
 * One error shape for every Surface.
 *
 * A GUI, a CLI, an MCP tool call, and a test must be able to branch on the same
 * `class` and `code`. Transports translate the class into their own vocabulary
 * (an exit code, a JSON-RPC error, an HTTP status) and never invent a second
 * error taxonomy.
 */

/** Stable error classes. Adding a class is a specification-level change. */
export const ERROR_CLASSES = Object.freeze([
  "input",
  "refused",
  "not_found",
  "conflict",
  "timeout",
  "unavailable",
  "internal"
]);

export class ActionError extends Error {
  constructor(errorClass, code, message, details) {
    super(`${code}: ${message}`);
    this.name = "ActionError";
    this.class = errorClass;
    this.code = code;
    this.detail = message;
    this.details = details;
  }

  /** The wire form. `details` is omitted rather than emitted as null. */
  toJSON() {
    const payload = { class: this.class, code: this.code, message: this.detail };
    if (this.details !== undefined) payload.details = this.details;
    return payload;
  }

  withDetails(details) {
    return new ActionError(this.class, this.code, this.detail, details);
  }

  /** The caller sent something the Action cannot accept. */
  static input(code, message, details) {
    return new ActionError("input", code, message, details);
  }

  /** The Action Core declined: missing confirmation, missing permission. */
  static refused(code, message, details) {
    return new ActionError("refused", code, message, details);
  }

  static notFound(code, message, details) {
    return new ActionError("not_found", code, message, details);
  }

  /** Concurrent or stale state. Never resolve this by last-writer-wins. */
  static conflict(code, message, details) {
    return new ActionError("conflict", code, message, details);
  }

  static timeout(code, message, details) {
    return new ActionError("timeout", code, message, details);
  }

  /** A dependency the Action needs is down or unreachable. */
  static unavailable(code, message, details) {
    return new ActionError("unavailable", code, message, details);
  }

  static internal(code, message, details) {
    return new ActionError("internal", code, message, details);
  }

  static isActionError(value) {
    return value instanceof ActionError;
  }
}

/**
 * Convert any thrown value into an ActionError without losing the cause.
 * A handler that throws a plain Error still produces a valid envelope, so a
 * missing try/catch cannot turn into an unstructured Surface-specific crash.
 */
export function toActionError(thrown) {
  if (ActionError.isActionError(thrown)) return thrown;
  if (thrown instanceof Error) {
    return ActionError.internal("action_threw", thrown.message || "The Action handler threw.", {
      name: thrown.name,
      ...(thrown.stack ? { stack: thrown.stack.split("\n").slice(0, 8).join("\n") } : {})
    });
  }
  return ActionError.internal("action_threw", "The Action handler threw a non-Error value.", {
    thrown: safeString(thrown)
  });
}

function safeString(value) {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}
