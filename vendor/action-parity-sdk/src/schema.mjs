/**
 * A dependency-free JSON Schema subset, plus a builder that emits ordinary
 * JSON Schema objects.
 *
 * The SDK ships this instead of depending on a validator so an Action Core can
 * be embedded in an Electron main process, a CLI, or an MCP server without
 * dragging a schema compiler into every build. Authors who already own Zod,
 * Valibot, or ArkType keep using them and hand the SDK the derived JSON Schema
 * plus a `parse` function; see `fromStandardSchema`.
 *
 * Supported keywords: $ref (local pointers), type, enum, const, properties,
 * required, additionalProperties, minProperties, maxProperties, items,
 * prefixItems, minItems, maxItems, uniqueItems, minLength, maxLength, pattern,
 * minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf, anyOf,
 * oneOf, allOf, not, and default. Anything else is ignored rather than
 * silently treated as a failure.
 */

const OPTIONAL = Symbol.for("action-parity.optional");

export function isSchemaObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Validate `value` against `schema`. Returns located issues, never throws. */
export function validateValue(schema, value, options = {}) {
  const root = options.root ?? schema;
  const issues = [];
  check(schema, value, "", root, issues, new Set());
  return { ok: issues.length === 0, issues };
}

/** Fill declared `default` values into an object without mutating the input. */
export function applyDefaults(schema, value, root = schema) {
  const resolved = resolveRef(schema, root);
  if (!isSchemaObject(resolved)) return value;
  if (resolved.properties && isSchemaObject(value)) {
    const filled = { ...value };
    for (const [key, property] of Object.entries(resolved.properties)) {
      const propertySchema = resolveRef(property, root);
      if (filled[key] === undefined) {
        if (isSchemaObject(propertySchema) && propertySchema.default !== undefined) {
          filled[key] = structuredClone(propertySchema.default);
        }
        continue;
      }
      filled[key] = applyDefaults(propertySchema, filled[key], root);
    }
    return filled;
  }
  if (value === undefined && resolved.default !== undefined) return structuredClone(resolved.default);
  return value;
}

/**
 * Turn one command-line string into the type its schema declares. Transports
 * that only carry text (argv, query strings, environment variables) call this
 * so the Action Core still receives real JSON types.
 */
export function coerceStringValue(schema, raw, root = schema) {
  const resolved = resolveRef(schema, root);
  const types = declaredTypes(resolved);
  if (types.includes("string")) return raw;
  if (types.includes("boolean") && /^(true|false)$/i.test(raw)) return /^true$/i.test(raw);
  if ((types.includes("integer") || types.includes("number")) && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (types.includes("null") && (raw === "null" || raw === "")) return null;
  if (types.includes("object") || types.includes("array")) {
    try {
      return JSON.parse(raw);
    } catch {
      if (types.includes("array")) return raw.split(",").map((part) => part.trim());
      return raw;
    }
  }
  if (types.length === 0) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

/** The top-level object properties a flag-based transport can expose. */
export function describeFlags(schema, root = schema) {
  const resolved = resolveRef(schema, root);
  if (!isSchemaObject(resolved) || !isSchemaObject(resolved.properties)) return [];
  const required = Array.isArray(resolved.required) ? resolved.required : [];
  return Object.entries(resolved.properties).map(([name, property]) => {
    const propertySchema = resolveRef(property, root);
    const types = declaredTypes(propertySchema);
    return {
      name,
      flag: `--${name.replace(/_/g, "-")}`,
      required: required.includes(name),
      boolean: types.length === 1 && types[0] === "boolean",
      repeatable: types.includes("array"),
      description: propertySchema?.description ?? "",
      schema: propertySchema,
      default: propertySchema?.default
    };
  });
}

/** Map a flag name back to its property name (`--dry-run` -> `dry_run`). */
export function flagToProperty(schema, flag, root = schema) {
  const normalized = flag.replace(/^--?/, "");
  for (const entry of describeFlags(schema, root)) {
    if (entry.name === normalized || entry.flag === `--${normalized}`) return entry;
    if (entry.name.replace(/_/g, "-") === normalized) return entry;
  }
  return null;
}

/**
 * Adapt a Standard Schema validator (Zod 4, Valibot, ArkType) to the SDK.
 * The JSON Schema stays explicit because the Manifest, MCP tool list, and CLI
 * catalog are published contracts; deriving them by guessing would let a
 * library upgrade silently rewrite a published interface.
 */
export function fromStandardSchema(validator, jsonSchema) {
  if (!isSchemaObject(jsonSchema)) {
    throw new TypeError(
      "fromStandardSchema needs an explicit JSON Schema, for example z.toJSONSchema(Input)."
    );
  }
  const standard = validator?.["~standard"];
  if (typeof standard?.validate !== "function") {
    throw new TypeError("fromStandardSchema needs a Standard Schema validator.");
  }
  return {
    jsonSchema,
    parse(value) {
      const result = standard.validate(value);
      if (result instanceof Promise) {
        throw new TypeError("Asynchronous Standard Schema validation is not supported.");
      }
      if (result.issues) {
        return {
          ok: false,
          issues: result.issues.map((issue) => ({
            path: pointerOf(issue.path),
            message: issue.message
          }))
        };
      }
      return { ok: true, value: result.value };
    }
  };
}

function pointerOf(path) {
  if (!Array.isArray(path) || path.length === 0) return "";
  return `/${path.map((segment) => String(segment?.key ?? segment)).join("/")}`;
}

function declaredTypes(schema) {
  if (!isSchemaObject(schema)) return [];
  if (typeof schema.type === "string") return [schema.type];
  if (Array.isArray(schema.type)) return schema.type;
  if (Array.isArray(schema.enum)) {
    return [...new Set(schema.enum.map((value) => jsonTypeOf(value)))];
  }
  if (schema.properties || schema.required || schema.additionalProperties !== undefined) {
    return ["object"];
  }
  if (schema.items || schema.prefixItems) return ["array"];
  return [];
}

function jsonTypeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function resolveRef(schema, root, seen = new Set()) {
  let current = schema;
  while (isSchemaObject(current) && typeof current.$ref === "string") {
    if (seen.has(current.$ref)) return {};
    seen.add(current.$ref);
    const target = pointerLookup(root, current.$ref);
    if (target === undefined) return {};
    current = target;
  }
  return current;
}

function pointerLookup(root, ref) {
  if (!ref.startsWith("#")) return undefined;
  const pointer = ref.slice(1);
  if (pointer === "" || pointer === "/") return root;
  let node = root;
  for (const rawSegment of pointer.split("/").slice(1)) {
    const segment = decodeURIComponent(rawSegment).replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isSchemaObject(node) && !Array.isArray(node)) return undefined;
    node = node[segment];
    if (node === undefined) return undefined;
  }
  return node;
}

function check(schema, value, path, root, issues, seen) {
  if (schema === true || schema === undefined) return;
  if (schema === false) {
    issues.push({ path, message: "No value is allowed here." });
    return;
  }
  if (!isSchemaObject(schema)) return;

  const resolved = resolveRef(schema, root, new Set(seen));
  if (!isSchemaObject(resolved)) return;

  const types = typeList(resolved);
  if (types.length > 0 && !types.some((type) => matchesType(type, value))) {
    issues.push({ path, message: `Expected ${types.join(" or ")}, received ${jsonTypeOf(value)}.` });
    return;
  }

  if (Array.isArray(resolved.enum) && !resolved.enum.some((option) => deepEqual(option, value))) {
    issues.push({ path, message: `Expected one of ${JSON.stringify(resolved.enum)}.` });
  }
  if ("const" in resolved && !deepEqual(resolved.const, value)) {
    issues.push({ path, message: `Expected ${JSON.stringify(resolved.const)}.` });
  }

  if (typeof value === "string") checkString(resolved, value, path, issues);
  if (typeof value === "number") checkNumber(resolved, value, path, issues);
  if (Array.isArray(value)) checkArray(resolved, value, path, root, issues, seen);
  else if (isSchemaObject(value)) checkObject(resolved, value, path, root, issues, seen);

  checkCombinators(resolved, value, path, root, issues, seen);
}

function typeList(schema) {
  if (typeof schema.type === "string") return [schema.type];
  if (Array.isArray(schema.type)) return schema.type;
  return [];
}

function matchesType(type, value) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isSchemaObject(value);
    default:
      return true;
  }
}

function checkString(schema, value, path, issues) {
  const length = [...value].length;
  if (typeof schema.minLength === "number" && length < schema.minLength) {
    issues.push({ path, message: `Expected at least ${schema.minLength} character(s).` });
  }
  if (typeof schema.maxLength === "number" && length > schema.maxLength) {
    issues.push({ path, message: `Expected at most ${schema.maxLength} character(s).` });
  }
  if (typeof schema.pattern === "string") {
    let expression = null;
    try {
      expression = new RegExp(schema.pattern, "u");
    } catch {
      try {
        expression = new RegExp(schema.pattern);
      } catch {
        expression = null;
      }
    }
    if (expression && !expression.test(value)) {
      issues.push({ path, message: `Expected a value matching ${schema.pattern}.` });
    }
  }
}

function checkNumber(schema, value, path, issues) {
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    issues.push({ path, message: `Expected a value >= ${schema.minimum}.` });
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    issues.push({ path, message: `Expected a value <= ${schema.maximum}.` });
  }
  if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
    issues.push({ path, message: `Expected a value > ${schema.exclusiveMinimum}.` });
  }
  if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
    issues.push({ path, message: `Expected a value < ${schema.exclusiveMaximum}.` });
  }
  if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
    const ratio = value / schema.multipleOf;
    if (Math.abs(ratio - Math.round(ratio)) > 1e-9) {
      issues.push({ path, message: `Expected a multiple of ${schema.multipleOf}.` });
    }
  }
}

function checkArray(schema, value, path, root, issues, seen) {
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    issues.push({ path, message: `Expected at least ${schema.minItems} item(s).` });
  }
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    issues.push({ path, message: `Expected at most ${schema.maxItems} item(s).` });
  }
  if (schema.uniqueItems === true) {
    const seenItems = new Set(value.map((item) => JSON.stringify(item)));
    if (seenItems.size !== value.length) issues.push({ path, message: "Expected unique items." });
  }
  const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
  value.forEach((item, index) => {
    const itemSchema = index < prefix.length ? prefix[index] : schema.items;
    if (itemSchema !== undefined) check(itemSchema, item, `${path}/${index}`, root, issues, seen);
  });
}

function checkObject(schema, value, path, root, issues, seen) {
  const keys = Object.keys(value);
  if (typeof schema.minProperties === "number" && keys.length < schema.minProperties) {
    issues.push({ path, message: `Expected at least ${schema.minProperties} propert(ies).` });
  }
  if (typeof schema.maxProperties === "number" && keys.length > schema.maxProperties) {
    issues.push({ path, message: `Expected at most ${schema.maxProperties} propert(ies).` });
  }
  for (const name of Array.isArray(schema.required) ? schema.required : []) {
    if (value[name] === undefined) {
      issues.push({ path: `${path}/${name}`, message: `Property ${name} is required.` });
    }
  }
  const properties = isSchemaObject(schema.properties) ? schema.properties : {};
  for (const [name, propertySchema] of Object.entries(properties)) {
    if (value[name] !== undefined) {
      check(propertySchema, value[name], `${path}/${name}`, root, issues, seen);
    }
  }
  if (schema.additionalProperties === false) {
    for (const name of keys) {
      if (!(name in properties)) {
        issues.push({ path: `${path}/${name}`, message: `Property ${name} is not allowed.` });
      }
    }
  } else if (isSchemaObject(schema.additionalProperties)) {
    for (const name of keys) {
      if (!(name in properties)) {
        check(schema.additionalProperties, value[name], `${path}/${name}`, root, issues, seen);
      }
    }
  }
}

function checkCombinators(schema, value, path, root, issues, seen) {
  for (const branch of Array.isArray(schema.allOf) ? schema.allOf : []) {
    check(branch, value, path, root, issues, seen);
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const matched = schema.anyOf.some((branch) => branchMatches(branch, value, root, seen));
    if (!matched) issues.push({ path, message: "Value matches none of the allowed variants." });
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const matches = schema.oneOf.filter((branch) => branchMatches(branch, value, root, seen)).length;
    if (matches !== 1) {
      issues.push({ path, message: `Expected exactly one matching variant, matched ${matches}.` });
    }
  }
  if (schema.not !== undefined && branchMatches(schema.not, value, root, seen)) {
    issues.push({ path, message: "Value matches a forbidden variant." });
  }
}

function branchMatches(branch, value, root, seen) {
  const branchIssues = [];
  check(branch, value, "", root, branchIssues, seen);
  return branchIssues.length === 0;
}

function deepEqual(left, right) {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (typeof left !== "object") return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => deepEqual(left[key], right[key]));
}

function annotate(schema, options) {
  const output = { ...schema };
  for (const key of ["title", "description", "default", "examples", "deprecated"]) {
    if (options?.[key] !== undefined) output[key] = options[key];
  }
  return output;
}

/**
 * A very small JSON Schema builder. Every helper returns a plain JSON Schema
 * object, so `s` is a convenience, never a lock-in: hand-written schemas and
 * `z.toJSONSchema(...)` output work in exactly the same places.
 */
export const s = {
  object(properties = {}, options = {}) {
    const required = [];
    const emitted = {};
    for (const [name, property] of Object.entries(properties)) {
      if (!property?.[OPTIONAL]) required.push(name);
      emitted[name] = stripOptional(property);
    }
    const schema = annotate(
      {
        type: "object",
        properties: emitted,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: options.additionalProperties ?? false
      },
      options
    );
    return schema;
  },
  string(options = {}) {
    return annotate(
      {
        type: "string",
        ...pick(options, ["minLength", "maxLength", "pattern", "format", "enum"])
      },
      options
    );
  },
  number(options = {}) {
    return annotate(
      { type: "number", ...pick(options, ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]) },
      options
    );
  },
  integer(options = {}) {
    return annotate(
      { type: "integer", ...pick(options, ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]) },
      options
    );
  },
  boolean(options = {}) {
    return annotate({ type: "boolean" }, options);
  },
  array(items, options = {}) {
    return annotate(
      { type: "array", items: stripOptional(items), ...pick(options, ["minItems", "maxItems", "uniqueItems"]) },
      options
    );
  },
  enum(values, options = {}) {
    return annotate({ enum: [...values] }, options);
  },
  literal(value, options = {}) {
    return annotate({ const: value }, options);
  },
  record(valueSchema, options = {}) {
    return annotate({ type: "object", additionalProperties: stripOptional(valueSchema) }, options);
  },
  union(variants, options = {}) {
    return annotate({ anyOf: variants.map(stripOptional) }, options);
  },
  nullable(schema, options = {}) {
    return annotate({ anyOf: [stripOptional(schema), { type: "null" }] }, options);
  },
  any(options = {}) {
    return annotate({}, options);
  },
  optional(schema) {
    return { ...stripOptional(schema), [OPTIONAL]: true };
  }
};

function stripOptional(schema) {
  if (!isSchemaObject(schema)) return schema;
  if (!schema[OPTIONAL]) return schema;
  const copy = { ...schema };
  delete copy[OPTIONAL];
  return copy;
}

function pick(source, keys) {
  const output = {};
  for (const key of keys) {
    if (source?.[key] !== undefined) output[key] = source[key];
  }
  return output;
}
