import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { AGENT_PROFILE_FILENAME, readAgentProfile } from "./project.mjs";
import { validateManifestObject } from "./validator.mjs";

const execFileAsync = promisify(execFile);

export const DOCTOR_FORMAT = "action-parity.doctor/v1";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor"
]);

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".py",
  ".rs",
  ".toml",
  ".ts",
  ".tsx"
]);

const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".py", ".rs", ".ts", ".tsx"]);
const AGENT_INSTRUCTION_NAMES = new Set(["AGENTS.md", "CLAUDE.md"]);
const ACTION_ID_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;

export async function doctorProject(projectPath = process.cwd()) {
  const root = path.resolve(projectPath);
  const metadata = await stat(root);
  if (!metadata.isDirectory()) throw new Error(`Doctor path is not a directory: ${root}`);

  const files = await walk(root);
  const agentProfile = await inspectAgentProfile(root);
  const generatedPaths = new Set(
    agentProfile?.valid ? agentProfile.generated_paths : []
  );
  const observations = {
    source: { files: 0, lines: 0, by_extension: {} },
    tauri: { command_definitions: [], invoke_calls: [] },
    action_ids: [],
    manifests: [],
    compatibility_profiles: [],
    agent_profile: agentProfile,
    tests: { definitions: 0, by_language: { rust: 0, javascript: 0, python: 0 } },
    agent_instructions: [],
    entrypoints: { node_bins: [], python_scripts: [], mcp_files: [] }
  };

  for (const absolute of files) {
    const relative = relativePath(root, absolute);
    const extension = path.extname(absolute).toLowerCase();
    const basename = path.basename(absolute);
    if (!TEXT_EXTENSIONS.has(extension) && !AGENT_INSTRUCTION_NAMES.has(basename)) continue;

    const text = await readFile(absolute, "utf8");
    const lines = lineCount(text);
    if (SOURCE_EXTENSIONS.has(extension)) {
      observations.source.files += 1;
      observations.source.lines += lines;
      observations.source.by_extension[extension] =
        (observations.source.by_extension[extension] ?? 0) + lines;
    }

    if (AGENT_INSTRUCTION_NAMES.has(basename)) {
      observations.agent_instructions.push({ file: relative, lines, bytes: Buffer.byteLength(text) });
    }

    collectTauri(relative, text, observations);
    collectActionIds(relative, text, observations, generatedPaths.has(relative));
    collectTests(extension, text, observations.tests);

    if (/mcp/i.test(basename) && SOURCE_EXTENSIONS.has(extension)) {
      observations.entrypoints.mcp_files.push(relative);
    }
    if (basename === "package.json") collectNodeBins(relative, text, observations.entrypoints);
    if (basename === "pyproject.toml") collectPythonScripts(relative, text, observations.entrypoints);

    if (basename === "action-parity.json") {
      observations.manifests.push(inspectManifest(relative, text));
    } else if (basename.endsWith(".action-profile.json")) {
      observations.compatibility_profiles.push(inspectCompatibilityProfile(relative, text, lines));
    }
  }

  normalizeObservations(observations);
  const git = await inspectGit(root);
  const findings = buildFindings(observations);
  const nextSteps = buildNextSteps(observations, findings);

  return {
    ok: findings.every((finding) => finding.severity !== "error"),
    format: DOCTOR_FORMAT,
    project: {
      name: path.basename(root),
      root,
      git
    },
    observations,
    findings,
    next_steps: nextSteps,
    limits: [
      "Doctor reports source structure, not semantic business-action coverage.",
      "A Tauri command can be a host/presentation command and is not automatically an Action.",
      "Only action-parity verify may claim executable parity evidence."
    ]
  };
}

async function inspectAgentProfile(root) {
  const absolute = path.join(root, AGENT_PROFILE_FILENAME);
  try {
    if (!(await stat(absolute)).isFile()) return null;
    const profile = await readAgentProfile(absolute);
    const generatedPaths = [];
    for (const declared of profile.generated_paths) {
      const resolved = path.resolve(root, declared);
      const relation = path.relative(root, resolved);
      if (relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
        throw new Error(`generated path escapes the project: ${declared}`);
      }
      generatedPaths.push(relativePath(root, resolved));
    }
    return {
      file: AGENT_PROFILE_FILENAME,
      valid: true,
      generated_paths: [...new Set(generatedPaths)].sort()
    };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    return {
      file: AGENT_PROFILE_FILENAME,
      valid: false,
      generated_paths: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function walk(root) {
  const output = [];
  const queue = [root];
  while (queue.length > 0) {
    const directory = queue.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) queue.push(absolute);
      } else if (entry.isFile()) {
        output.push(absolute);
      }
    }
  }
  return output.sort();
}

function collectTauri(file, text, observations) {
  if (path.extname(file) === ".rs") {
    const commandPattern = /#\[tauri::command(?:\([^\]]*\))?\]\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/g;
    for (const match of text.matchAll(commandPattern)) {
      observations.tauri.command_definitions.push({ name: match[1], file });
    }
  }

  if ([".js", ".jsx", ".ts", ".tsx"].includes(path.extname(file))) {
    const invokePattern = /\binvoke(?:<[^;\n()]{0,300}>)?\s*\(\s*["']([^"']+)["']/g;
    for (const match of text.matchAll(invokePattern)) {
      observations.tauri.invoke_calls.push({ name: match[1], file });
    }
  }
}

function collectActionIds(file, text, observations, generated = false) {
  const candidates = [];
  if (path.extname(file) === ".rs" && /(?:action|core|registry)/i.test(path.basename(file))) {
    for (const match of text.matchAll(/pub const\s+[A-Z][A-Z0-9_]*\s*:\s*&str\s*=\s*"([^"]+)"/g)) {
      candidates.push({ id: match[1], source: "rust_constant" });
    }
  }
  if ([".js", ".jsx", ".ts", ".tsx"].includes(path.extname(file))) {
    for (const match of text.matchAll(/data-action-id\s*=\s*["']([^"']+)["']/g)) {
      for (const id of match[1].split(/\s+/)) candidates.push({ id, source: "gui_binding" });
    }
    if (/(?:action|core|registry)/i.test(path.basename(file))) {
      for (const match of text.matchAll(/["']([a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+)["']/g)) {
        candidates.push({ id: match[1], source: "registry_literal" });
      }
    }
  }
  for (const candidate of candidates) {
    if (ACTION_ID_PATTERN.test(candidate.id)) {
      observations.action_ids.push({ ...candidate, file, generated });
    }
  }
}

function collectTests(extension, text, tests) {
  if (extension === ".rs") {
    const count = (text.match(/^\s*#\[(?:tokio::)?test\]/gm) ?? []).length;
    tests.by_language.rust += count;
    tests.definitions += count;
  } else if ([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"].includes(extension)) {
    const count = (text.match(/^\s*(?:test|it)\s*\(/gm) ?? []).length;
    tests.by_language.javascript += count;
    tests.definitions += count;
  } else if (extension === ".py") {
    const count = (text.match(/^\s*def\s+test_[A-Za-z0-9_]+\s*\(/gm) ?? []).length;
    tests.by_language.python += count;
    tests.definitions += count;
  }
}

function collectNodeBins(file, text, entrypoints) {
  try {
    const packageObject = JSON.parse(text);
    if (typeof packageObject.bin === "string") {
      entrypoints.node_bins.push({ name: packageObject.name ?? "bin", target: packageObject.bin, file });
    } else if (packageObject.bin && typeof packageObject.bin === "object") {
      for (const [name, target] of Object.entries(packageObject.bin)) {
        if (typeof target === "string") entrypoints.node_bins.push({ name, target, file });
      }
    }
  } catch {
    // Invalid package.json is outside Doctor's protocol scope.
  }
}

function collectPythonScripts(file, text, entrypoints) {
  let inScripts = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[project\.scripts\]\s*$/.test(line)) {
      inScripts = true;
      continue;
    }
    if (inScripts && /^\s*\[/.test(line)) break;
    if (!inScripts) continue;
    const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*["']([^"']+)["']/);
    if (match) entrypoints.python_scripts.push({ name: match[1], target: match[2], file });
  }
}

function inspectManifest(file, text) {
  try {
    const manifest = JSON.parse(text);
    const validation = validateManifestObject(manifest);
    const schemaIssues = validation.issues.filter((issue) => issue.code === "schema_validation");
    return {
      file,
      valid: schemaIssues.length === 0,
      conforms: validation.ok,
      spec_version: manifest.spec_version ?? null,
      actions: Array.isArray(manifest.actions) ? manifest.actions.length : 0,
      lines: lineCount(text),
      issue_codes: [...new Set(validation.issues.map((issue) => issue.code))]
    };
  } catch (error) {
    return {
      file,
      valid: false,
      conforms: false,
      spec_version: null,
      actions: 0,
      lines: lineCount(text),
      issue_codes: ["invalid_json"],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function inspectCompatibilityProfile(file, text, lines) {
  try {
    const profile = JSON.parse(text);
    const actions = profile.actions && typeof profile.actions === "object" ? Object.entries(profile.actions) : [];
    return {
      file,
      profile_id: profile.profile_id ?? null,
      actions: actions.map(([id, action]) => ({
        id,
        steps: Array.isArray(action?.steps) ? action.steps.length : 0,
        success_evidence: Array.isArray(action?.success_evidence) ? action.success_evidence.length : 0
      })),
      lines
    };
  } catch (error) {
    return {
      file,
      profile_id: null,
      actions: [],
      lines,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function normalizeObservations(observations) {
  observations.source.by_extension = Object.fromEntries(
    Object.entries(observations.source.by_extension).sort(([left], [right]) =>
      left.localeCompare(right)
    )
  );
  observations.tauri.command_definitions.sort(compareNameFile);
  observations.tauri.invoke_calls.sort(compareNameFile);
  observations.action_ids = uniqueBy(
    observations.action_ids.sort((left, right) =>
      `${left.id}:${left.file}:${left.source}:${left.generated}`.localeCompare(
        `${right.id}:${right.file}:${right.source}:${right.generated}`
      )
    ),
    (item) => `${item.id}:${item.file}:${item.source}:${item.generated}`
  );
  observations.manifests.sort(compareFile);
  observations.compatibility_profiles.sort(compareFile);
  observations.agent_instructions.sort(compareFile);
  observations.entrypoints.node_bins.sort(compareNameFile);
  observations.entrypoints.python_scripts.sort(compareNameFile);
  observations.entrypoints.mcp_files.sort();

  const definitions = new Set(observations.tauri.command_definitions.map((item) => item.name));
  const calls = new Set(observations.tauri.invoke_calls.map((item) => item.name));
  observations.tauri.summary = {
    command_definitions: observations.tauri.command_definitions.length,
    unique_defined_commands: definitions.size,
    invoke_call_sites: observations.tauri.invoke_calls.length,
    unique_invoked_commands: calls.size,
    invoked_without_detected_definition: [...calls].filter((name) => !definitions.has(name)).sort(),
    defined_without_static_invoke: [...definitions].filter((name) => !calls.has(name)).sort()
  };

  const profiles = observations.compatibility_profiles;
  const profileActions = profiles.flatMap((profile) => profile.actions);
  observations.compatibility_summary = {
    profiles: profiles.length,
    actions: profileActions.length,
    lines: profiles.reduce((total, profile) => total + profile.lines, 0),
    lines_per_action:
      profileActions.length === 0
        ? 0
        : Number((profiles.reduce((total, profile) => total + profile.lines, 0) / profileActions.length).toFixed(1)),
    steps: profileActions.reduce((total, action) => total + action.steps, 0),
    success_evidence: profileActions.reduce((total, action) => total + action.success_evidence, 0)
  };
}

function buildFindings(observations) {
  const findings = [];
  const tauri = observations.tauri.summary;
  if (tauri.command_definitions > 0 || tauri.invoke_call_sites > 0) {
    findings.push({
      severity: "info",
      code: "tauri_surface_observed",
      message: `${tauri.unique_defined_commands} Tauri commands and ${tauri.invoke_call_sites} static invoke call sites were observed. Classify business Actions before migration; do not convert host-only commands mechanically.`
    });
  }

  if (tauri.invoked_without_detected_definition.length > 0) {
    findings.push({
      severity: "warning",
      code: "tauri_binding_unresolved",
      message: `${tauri.invoked_without_detected_definition.length} invoked command names have no detected Rust definition. Generated bindings should make intentional plugin/external commands explicit.`,
      evidence: tauri.invoked_without_detected_definition
    });
  }

  const filesByAction = new Map();
  for (const occurrence of observations.action_ids) {
    if (occurrence.generated) continue;
    if (!filesByAction.has(occurrence.id)) filesByAction.set(occurrence.id, new Set());
    filesByAction.get(occurrence.id).add(occurrence.file);
  }
  const duplicated = [...filesByAction]
    .filter(([, files]) => files.size > 1)
    .map(([id, files]) => ({ id, files: [...files].sort() }))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (duplicated.length > 0) {
    findings.push({
      severity: "warning",
      code: "action_id_drift_risk",
      message: `${duplicated.length} Action IDs are repeated across files. Generate surface constants/bindings from the registry instead of maintaining copies.`,
      evidence: duplicated
    });
  }

  const compatibility = observations.compatibility_summary;
  if (compatibility.actions > 0) {
    findings.push({
      severity: "info",
      code: "external_ui_compatibility_layer",
      message: `${compatibility.actions} compatibility Actions use ${compatibility.lines} profile lines (${compatibility.lines_per_action} per Action). Treat this as a fallback adapter with observed-version and evidence data, not as proof that the target application has an Action Core.`
    });
  }

  const invalid = observations.manifests.filter((manifest) => !manifest.valid);
  if (invalid.length > 0) {
    findings.push({
      severity: "error",
      code: "manifest_invalid",
      message: `${invalid.length} checked-in ActionParity manifests fail the current JSON Schema.`,
      evidence: invalid.map((manifest) => ({ file: manifest.file, issue_codes: manifest.issue_codes }))
    });
  }

  const nonconforming = observations.manifests.filter(
    (manifest) => manifest.valid && !manifest.conforms
  );
  if (nonconforming.length > 0) {
    findings.push({
      severity: "warning",
      code: "manifest_nonconforming",
      message: `${nonconforming.length} schema-valid manifests do not satisfy the current architecture checks. This can be intentional for regression fixtures; run validate on production manifests.`,
      evidence: nonconforming.map((manifest) => ({ file: manifest.file, issue_codes: manifest.issue_codes }))
    });
  }

  if (observations.agent_instructions.length > 0) {
    const lines = observations.agent_instructions.reduce((total, item) => total + item.lines, 0);
    findings.push({
      severity: "info",
      code: "agent_context_observed",
      message: `${observations.agent_instructions.length} AI instruction files contain ${lines} lines. Keep Action metadata discoverable as JSON so agents need not infer it from prose.`
    });
  }
  return findings;
}

function buildNextSteps(observations, findings) {
  const steps = [];
  if (observations.tauri.summary.command_definitions > 0) {
    steps.push({
      priority: 1,
      code: "classify_tauri_commands",
      action: "Classify detected commands as business Action, host capability, or presentation-only; migrate one vertical slice, not every command."
    });
  }
  if (findings.some((finding) => finding.code === "action_id_drift_risk")) {
    steps.push({
      priority: 1,
      code: "generate_surface_bindings",
      action: "Choose one registry as the source of truth and generate GUI constants, CLI help, MCP tools, and the Manifest from it."
    });
  }
  if (observations.compatibility_summary.actions > 0) {
    steps.push({
      priority: 1,
      code: "measure_compatibility_replay",
      action: "Record locator tier, retries, duration, observed app version, and business success evidence for every compatibility replay."
    });
  }
  if (observations.manifests.length === 0 && observations.action_ids.length > 0) {
    steps.push({
      priority: 2,
      code: "export_registry_bundle",
      action: "Add a read-only registry export and let action-parity generate the checked-in protocol artifacts."
    });
  }
  if (steps.length === 0) {
    steps.push({
      priority: 2,
      code: "inventory_business_actions",
      action: "Inventory meaningful user Actions and select the smallest domain that already needs a second interface or AI access."
    });
  }
  return steps.sort((left, right) => left.priority - right.priority || left.code.localeCompare(right.code));
}

async function inspectGit(root) {
  try {
    const [commit, branch, statusOutput] = await Promise.all([
      git(root, ["rev-parse", "HEAD"]),
      git(root, ["branch", "--show-current"]),
      git(root, ["status", "--porcelain"])
    ]);
    const changedPaths = statusOutput
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3).trim());
    return {
      commit,
      branch: branch || null,
      dirty: changedPaths.length > 0,
      changed_paths: changedPaths
    };
  } catch {
    return null;
  }
}

async function git(root, args) {
  const result = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000
  });
  return result.stdout.trimEnd();
}

function lineCount(text) {
  return text === "" ? 0 : text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0);
}

function relativePath(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join("/");
}

function compareFile(left, right) {
  return left.file.localeCompare(right.file);
}

function compareNameFile(left, right) {
  return `${left.name}:${left.file}`.localeCompare(`${right.name}:${right.file}`);
}

function uniqueBy(items, key) {
  const seen = new Set();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
