import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { validateManifestObject } from "./validator.mjs";

export const AGENT_PROFILE_FORMAT = "action-parity.agent-profile/v1";
export const AGENT_CONTEXT_FORMAT = "action-parity.agent-context/v1";
export const AGENT_PROFILE_FILENAME = "action-parity.config.json";

const profileSchemaUrl = new URL(
  "../schema/action-parity.agent-profile.schema.json",
  import.meta.url
);
const profileSchema = JSON.parse(readFileSync(profileSchemaUrl, "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
const validateProfileSchema = ajv.compile(profileSchema);

export async function discoverAgentProfile(startPath = process.cwd()) {
  let current = path.resolve(startPath);
  try {
    if ((await stat(current)).isFile()) {
      if (path.basename(current) === AGENT_PROFILE_FILENAME) return current;
      current = path.dirname(current);
    }
  } catch {
    throw new Error(`Project path does not exist: ${current}`);
  }

  while (true) {
    const candidate = path.join(current, AGENT_PROFILE_FILENAME);
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Continue toward the filesystem root.
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    `No ${AGENT_PROFILE_FILENAME} found from ${path.resolve(startPath)} to the filesystem root.`
  );
}

export async function readAgentProfile(profilePath) {
  const profile = JSON.parse(await readFile(profilePath, "utf8"));
  if (!validateProfileSchema(profile)) {
    const details = (validateProfileSchema.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`Invalid Agent Profile: ${details}`);
  }
  return profile;
}

export async function buildAgentContext(startPath = process.cwd()) {
  const profilePath = await discoverAgentProfile(startPath);
  const projectRoot = path.dirname(profilePath);
  const profile = await readAgentProfile(profilePath);
  const manifestPath = resolveInsideProject(projectRoot, profile.manifest, "manifest");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const validation = validateManifestObject(manifest);
  const surfaceById = new Map(
    arrayOrEmpty(manifest?.surfaces)
      .filter((surface) => surface?.id)
      .map((surface) => [surface.id, surface])
  );

  return {
    ok: validation.ok,
    format: AGENT_CONTEXT_FORMAT,
    project_root: projectRoot,
    profile_path: profilePath,
    application: manifest?.application ?? null,
    spec_version: manifest?.spec_version ?? null,
    registry: {
      export: profile.registry.export,
      source_paths: (profile.registry.source_paths ?? []).map((item) => ({
        relative: item,
        absolute: resolveInsideProject(projectRoot, item, "registry source")
      }))
    },
    manifest: {
      relative: profile.manifest,
      absolute: manifestPath,
      valid: validation.ok,
      errors: validation.issues.filter((issue) => issue.severity === "error")
    },
    generated_paths: profile.generated_paths.map((item) => ({
      relative: item,
      absolute: resolveInsideProject(projectRoot, item, "generated path"),
      editable: false
    })),
    commands: profile.commands,
    surfaces: arrayOrEmpty(manifest?.surfaces).map((surface) => ({
      id: surface?.id ?? null,
      kind: surface?.kind ?? null,
      reachability: surface?.reachability ?? null,
      required_for_parity: surface?.required_for_parity ?? null
    })),
    actions: arrayOrEmpty(manifest?.actions).map((action) => ({
      id: action?.id ?? null,
      title: action?.title ?? null,
      effect_class: action?.effects?.class ?? null,
      risk: action?.effects?.risk ?? null,
      surfaces: arrayOrEmpty(action?.bindings).map((binding) => ({
        id: binding?.surface ?? null,
        kind: surfaceById.get(binding?.surface)?.kind ?? null,
        target: binding?.target ?? null
      }))
    })),
    agent_policy: {
      source_of_truth: "registry",
      edit_generated_files: false,
      completion_command: profile.commands.verify_changed ?? profile.commands.verify
    }
  };
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function resolveInsideProject(projectRoot, relativePath, label) {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be relative to the Agent Profile.`);
  }
  const absolute = path.resolve(projectRoot, relativePath);
  const relation = path.relative(projectRoot, absolute);
  if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`${label} escapes the project root: ${relativePath}`);
  }
  return absolute;
}
