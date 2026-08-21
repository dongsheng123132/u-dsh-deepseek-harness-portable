import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { canonicalize, stableStringify, validateRegistryBundle } from "./generator.mjs";
import { readManifest, validateManifestObject } from "./validator.mjs";

const REPORT_FORMAT = "action-parity.evidence/v1";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

export async function verifyManifest(manifestPath, options = {}) {
  const absoluteManifest = path.resolve(manifestPath);
  const planPath = path.resolve(
    options.planPath ?? path.join(path.dirname(absoluteManifest), "action-parity.verify.json")
  );
  const planDirectory = path.dirname(planPath);
  const [manifest, plan, manifestText, planText] = await Promise.all([
    readManifest(absoluteManifest),
    readJson(planPath),
    readFile(absoluteManifest, "utf8"),
    readFile(planPath, "utf8")
  ]);
  validatePlan(plan);

  const staticValidation = validateManifestObject(manifest);
  const generatorCheck = plan.generator
    ? await verifyGenerator(plan.generator, planDirectory, manifest)
    : null;
  const tests = [];
  for (const test of plan.tests) {
    tests.push(await runDeclaredTest(test, planDirectory));
  }

  const resultByRef = new Map(tests.map((test) => [test.ref, test]));
  const bindings = manifest.actions.flatMap((action) =>
    action.bindings.map((binding) => {
      const result = binding.test ? resultByRef.get(binding.test) : undefined;
      const observed = result?.observations?.some(
        (observation) =>
          observation.action_id === action.id &&
          observation.surface === binding.surface &&
          typeof observation.request_execution_id === "string" &&
          observation.request_execution_id.length > 0 &&
          observation.request_execution_id === observation.core_execution_id
      );
      return {
        action_id: action.id,
        surface: binding.surface,
        declared_test: binding.test ?? null,
        status: !binding.test
          ? "undeclared"
          : result?.passed && observed
            ? "verified"
            : "unverified"
      };
    })
  );
  const requiredSurfaceIds = new Set(
    manifest.surfaces
      .filter((surface) => surface.required_for_parity)
      .map((surface) => surface.id)
  );
  const requiredBindings = bindings.filter((binding) => requiredSurfaceIds.has(binding.surface));
  const verifiedBindings = requiredBindings.filter((binding) => binding.status === "verified").length;
  const artifacts = await hashArtifacts(plan.artifacts ?? [], planDirectory);
  const git = await gitIdentity(path.dirname(absoluteManifest));

  const verified =
    staticValidation.ok &&
    (generatorCheck === null || generatorCheck.passed) &&
    tests.length > 0 &&
    tests.every((test) => test.passed) &&
    artifacts.every((artifact) => !artifact.error) &&
    requiredBindings.length > 0 &&
    verifiedBindings === requiredBindings.length;

  const report = {
    format: REPORT_FORMAT,
    verified,
    generated_at: new Date().toISOString(),
    application: manifest.application,
    spec_version: manifest.spec_version,
    source: {
      manifest: {
        path: absoluteManifest,
        sha256: sha256(manifestText)
      },
      plan: {
        path: planPath,
        sha256: sha256(planText)
      },
      git,
      artifacts
    },
    environment: {
      platform: process.platform,
      os_release: os.release(),
      arch: process.arch,
      node: process.version
    },
    static_validation: {
      ok: staticValidation.ok,
      evidence_status: "declared",
      issues: staticValidation.issues
    },
    generator: generatorCheck,
    tests,
    audit: {
      achieved: verified ? "AP-2" : staticValidation.audit.achieved,
      verified_at_runtime: verified
    },
    bindings: {
      required: requiredBindings.length,
      verified: verifiedBindings,
      verified_percent:
        requiredBindings.length === 0
          ? 0
          : Math.round((verifiedBindings / requiredBindings.length) * 1000) / 10,
      entries: bindings
    }
  };
  report.report_sha256 = sha256(stableStringify(report));

  if (options.outputPath) {
    const outputPath = path.resolve(options.outputPath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${stableStringify(report, 2)}\n`, "utf8");
  }
  return report;
}

async function verifyGenerator(generator, cwd, manifest) {
  const result = await runCommand(generator.command, {
    cwd: resolveCwd(cwd, generator.cwd),
    timeoutMs: generator.timeout_ms,
    env: generator.env
  });
  let generatedManifest = null;
  let parseError = null;
  if (result.exit_code === 0) {
    try {
      const bundle = JSON.parse(result.stdout);
      validateRegistryBundle(bundle);
      generatedManifest = bundle.manifest;
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
  }
  const matches =
    generatedManifest !== null &&
    stableStringify(generatedManifest) === stableStringify(canonicalize(manifest));
  return {
    ...publicCommandResult(result),
    passed: result.exit_code === 0 && !result.timed_out && parseError === null && matches,
    manifest_matches: matches,
    parse_error: parseError
  };
}

async function runDeclaredTest(test, cwd) {
  const commandCwd = resolveCwd(cwd, test.cwd);
  const result = await runCommand(test.command, {
    cwd: commandCwd,
    timeoutMs: test.timeout_ms,
    env: test.env
  });
  let observations = [];
  let observationsError = null;
  if (result.exit_code === 0 && !result.timed_out) {
    try {
      observations = JSON.parse(
        await readFile(path.resolve(commandCwd, test.observations), "utf8")
      );
      if (!Array.isArray(observations)) throw new Error("observation output is not an array");
    } catch (error) {
      observationsError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    ref: test.ref,
    ...publicCommandResult(result),
    passed: result.exit_code === 0 && !result.timed_out && observationsError === null,
    observations,
    observations_error: observationsError
  };
}

function publicCommandResult(result) {
  return {
    command: result.command,
    cwd: result.cwd,
    exit_code: result.exit_code,
    duration_ms: result.duration_ms,
    timed_out: result.timed_out,
    spawn_error: result.spawn_error,
    output_truncated: result.output_truncated,
    stdout_sha256: sha256(result.stdout),
    stderr_sha256: sha256(result.stderr)
  };
}

export async function runCommand(command, options = {}) {
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string")) {
    throw new Error("Verification commands must be non-empty string arrays.");
  }
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = process.hrtime.bigint();
  return await new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let outputTruncated = false;
    let settled = false;
    const append = (current, chunk) => {
      const combined = Buffer.concat([current, chunk]);
      if (combined.length > MAX_CAPTURE_BYTES) {
        outputTruncated = true;
        child.kill();
        return combined.subarray(0, MAX_CAPTURE_BYTES);
      }
      return combined;
    };
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        resolve({
          command: [...command],
          cwd,
          exit_code: null,
          timed_out: false,
          spawn_error: error.message,
          output_truncated: false,
          duration_ms: Number((process.hrtime.bigint() - started) / 1_000_000n),
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8")
        });
      }
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      resolve({
        command: [...command],
        cwd,
        exit_code: code,
        timed_out: timedOut,
        spawn_error: null,
        output_truncated: outputTruncated,
        duration_ms: Number((process.hrtime.bigint() - started) / 1_000_000n),
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8")
      });
    });
  });
}

function validatePlan(plan) {
  if (!plan || plan.version !== 1 || !Array.isArray(plan.tests)) {
    throw new Error("Verification plan must have version 1 and a tests array.");
  }
  const refs = new Set();
  for (const test of plan.tests) {
    if (!test?.ref || refs.has(test.ref)) throw new Error("Each verification test needs a unique ref.");
    refs.add(test.ref);
    validateCommand(test.command);
    if (typeof test.observations !== "string" || test.observations.length === 0) {
      throw new Error(`Verification test ${test.ref} must name its observations JSON output.`);
    }
  }
  if (plan.generator) validateCommand(plan.generator.command);
  if (plan.artifacts && !Array.isArray(plan.artifacts)) {
    throw new Error("Verification plan artifacts must be an array of paths.");
  }
}

function validateCommand(command) {
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string")) {
    throw new Error("Commands are arrays: [program, arg1, ...]. Shell strings are not accepted.");
  }
}

async function hashArtifacts(artifacts, cwd) {
  const output = [];
  for (const relative of artifacts) {
    const expanded = relative.replaceAll("{exe}", process.platform === "win32" ? ".exe" : "");
    const absolute = path.resolve(cwd, expanded);
    try {
      const info = await stat(absolute);
      if (!info.isFile()) throw new Error("not a file");
      const content = await readFile(absolute);
      output.push({ path: absolute, bytes: info.size, sha256: sha256(content) });
    } catch (error) {
      output.push({ path: absolute, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return output;
}

async function gitIdentity(cwd) {
  try {
    const commit = await runCommand(["git", "rev-parse", "HEAD"], { cwd, timeoutMs: 5_000 });
    const status = await runCommand(["git", "status", "--porcelain"], { cwd, timeoutMs: 5_000 });
    if (commit.exit_code !== 0 || status.exit_code !== 0) return null;
    return {
      commit: commit.stdout.trim(),
      dirty: status.stdout.trim().length > 0
    };
  } catch {
    return null;
  }
}

function resolveCwd(base, relative) {
  return relative ? path.resolve(base, relative) : base;
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
