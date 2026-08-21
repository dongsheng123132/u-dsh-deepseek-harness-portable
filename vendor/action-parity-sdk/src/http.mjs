/**
 * The HTTP/API Shadow.
 *
 * A `node:http` request listener that forwards to the same Action Core. It
 * exists so a remote or Shadow-device caller reaches the identical envelope,
 * confirmation rule, and state-version check that the GUI and CLI reach.
 *
 * Status codes are derived from the error class, never chosen per Action, so a
 * client can branch on HTTP status and on `error.class` interchangeably.
 */

export const STATUS_FOR_CLASS = Object.freeze({
  input: 400,
  refused: 403,
  not_found: 404,
  conflict: 409,
  timeout: 504,
  unavailable: 503,
  internal: 500
});

/**
 * The Action Core classifies "this Action ID is not registered" as an input
 * fault, matching the Rust core so cross-language clients branch identically.
 * Over HTTP the same fault is a missing resource, so these three codes are
 * mapped explicitly instead of quietly answering 400 for a bad URL.
 */
export const STATUS_FOR_CODE = Object.freeze({
  unknown_action: 404,
  unknown_surface: 404,
  action_not_exposed_on_surface: 404
});

const MAX_BODY_BYTES = 1024 * 1024;

export function createHttpHandler(registry, options = {}) {
  const base = (options.basePath ?? "/").replace(/\/+$/, "");
  const surface = options.surface ?? "api";

  return async function handle(request, response) {
    const url = new URL(request.url ?? "/", "http://localhost");
    const route = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : null;
    if (route === null) return send(response, 404, { ok: false, error: notFound("No such route.") });

    if (request.method === "GET" && (route === "/actions" || route === "/actions/")) {
      return send(response, 200, {
        ok: true,
        application: registry.application,
        actions: registry.actionsForSurface(surface).map((action) => ({
          id: action.id,
          title: action.title,
          description: action.description,
          input_schema: action.input.jsonSchema,
          output_schema: action.output.jsonSchema,
          effects: action.effects
        }))
      });
    }
    if (request.method === "GET" && route === "/manifest") {
      return send(response, 200, registry.manifest());
    }

    const match = /^\/actions\/([a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+)$/.exec(route);
    if (!match) return send(response, 404, { ok: false, error: notFound("No such route.") });
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      return send(response, 405, {
        ok: false,
        error: { class: "input", code: "method_not_allowed", message: "Use POST." }
      });
    }

    let actor = null;
    if (options.authenticate) {
      actor = await options.authenticate(request);
      if (!actor) {
        return send(response, 401, {
          ok: false,
          error: {
            class: "refused",
            code: "unauthenticated",
            message: "This Surface requires authentication."
          }
        });
      }
    }

    let input;
    try {
      const body = await readBody(request);
      input = body === "" ? {} : JSON.parse(body);
    } catch (error) {
      return send(response, 400, {
        ok: false,
        error: { class: "input", code: "invalid_json_body", message: error.message }
      });
    }

    const envelope = await registry.dispatch({
      actionId: match[1],
      input,
      surface,
      actor,
      confirmed: header(request, "x-action-confirm") === "true",
      ...(header(request, "x-action-execution-id")
        ? { executionId: header(request, "x-action-execution-id") }
        : {}),
      ...(header(request, "idempotency-key")
        ? { idempotencyKey: header(request, "idempotency-key") }
        : {}),
      ...(header(request, "x-expected-state-version")
        ? { expectedStateVersion: header(request, "x-expected-state-version") }
        : {})
    });

    response.setHeader("x-action-execution-id", envelope.execution_id);
    return send(response, envelope.ok ? 200 : statusFor(envelope.error), envelope);
  };
}

function statusFor(error) {
  return STATUS_FOR_CODE[error.code] ?? STATUS_FOR_CLASS[error.class] ?? 500;
}

function notFound(message) {
  return { class: "not_found", code: "unknown_route", message };
}

function header(request, name) {
  const value = request.headers?.[name];
  return Array.isArray(value) ? value[0] : (value ?? null);
}

function send(response, status, payload) {
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body exceeds 1 MiB."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", reject);
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}
