import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateManifestObject } from "./validator.mjs";
import { generateTypeScriptClient } from "./typescript.mjs";

export const REGISTRY_BUNDLE_FORMAT = "action-parity.registry-bundle/v1";

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }
  return value;
}
export function stableStringify(value, space = 0) {
  return JSON.stringify(canonicalize(value), null, space);
}

export function validateRegistryBundle(bundle) {
  if (!bundle || bundle.format !== REGISTRY_BUNDLE_FORMAT) {
    throw new Error(`Expected registry bundle format ${REGISTRY_BUNDLE_FORMAT}.`);
  }
  if (!bundle.manifest || !bundle.cli_help || !bundle.mcp_tools) {
    throw new Error("Registry bundle must contain manifest, cli_help, and mcp_tools.");
  }
  const report = validateManifestObject(bundle.manifest);
  if (!report.ok) {
    const details = report.issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("\n");
    throw new Error(`Generated manifest is invalid:\n${details}`);
  }
  return report;
}

export async function readRegistryBundle(bundlePath) {
  return JSON.parse(await readFile(bundlePath, "utf8"));
}

export async function readGenerationSource(sourcePath) {
  return JSON.parse(await readFile(sourcePath, "utf8"));
}

export function validateGenerationSource(source, options = {}) {
  if (source?.format === REGISTRY_BUNDLE_FORMAT) {
    validateRegistryBundle(source);
    return "registry_bundle";
  }

  const report = validateManifestObject(source);
  if (!report.ok) {
    const details = report.issues
      .filter((issue) => issue.severity === "error")
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join("\n");
    throw new Error(`Manifest source is invalid:\n${details}`);
  }
  if (options.typescript !== true) {
    throw new Error(
      "A Manifest source can currently generate only the TypeScript client; pass --typescript."
    );
  }
  return "manifest";
}

export async function materializeRegistryBundle(bundle, outputDirectory, options = {}) {
  validateRegistryBundle(bundle);
  await mkdir(outputDirectory, { recursive: true });
  const artifacts = registryArtifacts(bundle, options);
  for (const [filename, content] of artifacts) {
    await atomicWrite(path.join(outputDirectory, filename), content);
  }
  return artifacts.map(([filename]) => path.join(outputDirectory, filename));
}

export async function checkRegistryBundle(bundle, outputDirectory, options = {}) {
  validateRegistryBundle(bundle);
  const files = [];
  for (const [filename, expected] of registryArtifacts(bundle, options)) {
    const target = path.join(outputDirectory, filename);
    let actual = null;
    try {
      actual = await readFile(target, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    files.push({
      path: target,
      status: generatedTextMatches(actual, expected) ? "current" : actual === null ? "missing" : "drifted"
    });
  }
  return { ok: files.every((file) => file.status === "current"), files };
}

export async function materializeGenerationSource(source, outputDirectory, options = {}) {
  validateGenerationSource(source, options);
  await mkdir(outputDirectory, { recursive: true });
  const artifacts = generationArtifacts(source, options);
  for (const [filename, content] of artifacts) {
    await atomicWrite(path.join(outputDirectory, filename), content);
  }
  return artifacts.map(([filename]) => path.join(outputDirectory, filename));
}

export async function checkGenerationSource(source, outputDirectory, options = {}) {
  validateGenerationSource(source, options);
  const files = [];
  for (const [filename, expected] of generationArtifacts(source, options)) {
    const target = path.join(outputDirectory, filename);
    let actual = null;
    try {
      actual = await readFile(target, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    files.push({
      path: target,
      status: generatedTextMatches(actual, expected) ? "current" : actual === null ? "missing" : "drifted"
    });
  }
  return { ok: files.every((file) => file.status === "current"), files };
}

function generationArtifacts(source, options) {
  if (source?.format === REGISTRY_BUNDLE_FORMAT) return registryArtifacts(source, options);
  return [["action-client.ts", generateTypeScriptClient(source)]];
}

function registryArtifacts(bundle, options) {
  const artifacts = [
    ["action-parity.json", `${stableStringify(bundle.manifest, 2)}\n`],
    ["cli-help.json", `${stableStringify(bundle.cli_help, 2)}\n`],
    ["mcp-tools.json", `${stableStringify(bundle.mcp_tools, 2)}\n`]
  ];
  if (options.typescript === true) {
    artifacts.push(["action-client.ts", generateTypeScriptClient(bundle.manifest)]);
  }
  return artifacts;
}

/**
 * Compare generated content to what is on disk. Exported so the example
 * generators share this one definition: a checkout with core.autocrlf=true
 * hands back CRLF for a file the generator wrote as LF, and that is not drift.
 */
export function generatedTextMatches(actual, expected) {
  if (actual === null) return false;
  return normalizeLineEndings(actual) === normalizeLineEndings(expected);
}

function normalizeLineEndings(value) {
  return value.replace(/\r\n/g, "\n");
}

async function atomicWrite(target, content) {
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, target);
}
