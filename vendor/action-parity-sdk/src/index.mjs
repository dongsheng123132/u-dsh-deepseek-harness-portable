/**
 * action-parity-sdk — the Action Core for Node, Electron, and TypeScript.
 *
 *   import { createRegistry, defineAction, defineSurface, s } from "action-parity-sdk";
 *
 * Register a business Action once. The CLI (`action-parity-sdk/cli`), the MCP
 * server (`action-parity-sdk/mcp`), Electron IPC (`action-parity-sdk/electron`),
 * and HTTP (`action-parity-sdk/http`) are callers of that one registry, and
 * `registry.artifactBundle()` is what `action-parity generate` turns into the
 * Manifest, CLI catalog, MCP tool list, and typed client.
 */

export {
  ActionRegistry,
  BUNDLE_FORMAT,
  CLI_HELP_FORMAT,
  ENVELOPE_VERSION,
  MANIFEST_SPEC_VERSION,
  RegistryError,
  SDK_VERSION,
  confirmationRequired,
  createRegistry,
  defineAction,
  defineSurface,
  exposedOn,
  nextExecutionId
} from "./registry.mjs";

export { ActionError, ERROR_CLASSES, toActionError } from "./errors.mjs";

export {
  applyDefaults,
  coerceStringValue,
  describeFlags,
  flagToProperty,
  fromStandardSchema,
  isSchemaObject,
  s,
  validateValue
} from "./schema.mjs";
