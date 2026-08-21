#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  checkGenerationSource,
  materializeGenerationSource,
  readGenerationSource
} from "../src/generator.mjs";
import { readManifest, validateManifestObject } from "../src/validator.mjs";
import { verifyManifest } from "../src/verifier.mjs";
import { buildAgentContext } from "../src/project.mjs";
import { doctorProject } from "../src/doctor.mjs";

const VERSION = "0.7.0";
const MANIFEST_SPEC_VERSION = "0.5.0";
const SUPPORTED_MANIFEST_SPEC_VERSIONS = [MANIFEST_SPEC_VERSION];

function usage() {
  return `ActionParity ${VERSION}

Usage:
  action-parity validate <manifest> [--json] [--quiet]
  action-parity report <manifest> [--json] [--quiet]
  action-parity generate <registry-bundle|manifest> --out-dir <directory> [--typescript] [--check] [--json]
  action-parity verify <manifest> [--plan <plan>] [--out <report>] [--json] [--quiet]
  action-parity context [project-directory|action-parity.config.json] [--json] [--quiet]
  action-parity doctor [project-directory] [--json] [--quiet]
  action-parity --version [--json]

Evidence model:
  validate/report  statically checks declarations; named tests are not executed
  verify           runs the generator and tests, hashes inputs, and emits evidence

Exit codes:
  0  valid / generated / verified / context or doctor completed
  1  runtime, conformance, generation, or verification failure
  2  invalid usage`;
}

function jsonEnvelope(data, runtimeError = null) {
  return {
    ok: runtimeError === null && (data?.ok === true || data?.verified === true),
    data,
    error: runtimeError ?? (data?.ok || data?.verified ? null : "operation_failed")
  };
}

function printHumanReport(report, mode) {
  const summary = report.summary;
  const audit = report.audit ?? { targets: [], achieved: "none", blockers: [], notes: [] };
  const violations = report.violations ?? [];
  const unproven = report.unproven ?? [];
  const lines = [
    `${report.application?.name ?? "Unknown application"} ${report.application?.version ?? ""}`.trim(),
    `Specification\t${report.spec_version ?? "unknown"}`,
    `Actions\t${summary.actions}`,
    `Evidence\tdeclared only (run verify to execute it)`,
    ""
  ];

  if (mode === "validate") lines.unshift(report.ok ? "VALID DECLARATIONS" : "INVALID");

  for (const shadow of report.shadows ?? []) {
    lines.push(
      `Shadow ${shadow.id}\t${shadow.kind}/${shadow.reachability}\t${shadow.actions} action(s)\t${
        shadow.declared_test_bindings
      } test declaration(s)\t${shadow.checked ? "checked" : "NOT CHECKED"}`
    );
  }

  lines.push("", `Violations\t${violations.length}`);
  for (const item of violations) lines.push(`  ${item.code}\t${item.path}\t${item.message}`);

  lines.push("", `Unproven\t${unproven.length}`);
  for (const item of unproven) lines.push(`  ${item.code}\t${item.path}\t${item.message}`);

  for (const resource of summary.shared_external_resources ?? []) {
    lines.push(
      `Shared resource\t${resource.path}\t${resource.access}\t${
        resource.concurrency ?? "NO CONCURRENCY POLICY"
      }`
    );
  }

  for (const excluded of summary.excluded_machine_surfaces ?? []) {
    lines.push(
      `Excluded ${excluded.id}\t${excluded.kind}/${excluded.reachability}\tnot checked\t${
        excluded.reason ?? "NO REASON STATED"
      }`
    );
  }

  const otherIssues = report.issues.filter(
    (item) => !violations.includes(item) && !unproven.includes(item)
  );
  if (otherIssues.length > 0) {
    lines.push("");
    for (const item of otherIssues) {
      lines.push(`${item.severity.toUpperCase()}\t${item.code}\t${item.path}\t${item.message}`);
    }
  }

  lines.push(
    "",
    `-- audit profile (optional) --`,
    `Declared parity\t${summary.declared_parity_percent}%`,
    `Declared test coverage\t${summary.declared_test_coverage_percent}%\t${summary.declared_test_bindings}/${summary.total_required_bindings} name a test`,
    `Exceptions\t${summary.declared_exceptions}`,
    `Targets\t${audit.targets.length > 0 ? audit.targets.join(", ") : "none declared"}`,
    `Static ceiling\t${audit.achieved}`
  );

  for (const blocker of audit.blockers) lines.push(`BLOCKER\t${blocker}`);
  for (const note of audit.notes) lines.push(`NOTE\t${note}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

function failUsage(message, jsonMode) {
  if (jsonMode) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, data: null, error: "invalid_usage", message })}\n`
    );
  } else {
    process.stderr.write(`${message}\n\n${usage()}\n`);
  }
  process.exitCode = 2;
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
}

function positionalArgs(args) {
  const values = new Set(["--plan", "--out", "--out-dir"]);
  const output = [];
  for (let index = 0; index < args.length; index += 1) {
    if (values.has(args[index])) {
      index += 1;
    } else if (!["--json", "--quiet", "-q", "--typescript", "--check"].includes(args[index])) {
      output.push(args[index]);
    }
  }
  return output;
}

async function runStatic(mode, manifestPath, jsonMode, quiet) {
  const manifest = await readManifest(manifestPath);
  const report = validateManifestObject(manifest);
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(jsonEnvelope({ ...report, ok: report.ok }))}\n`);
  } else if (!quiet || !report.ok) {
    printHumanReport(report, mode);
  }
  process.exitCode = report.ok ? 0 : 1;
}

async function runGenerate(sourcePath, outputDirectory, jsonMode, typescript, check) {
  if (!outputDirectory) {
    failUsage("generate requires --out-dir <directory>.", jsonMode);
    return;
  }
  const source = await readGenerationSource(sourcePath);
  const destination = path.resolve(outputDirectory);
  if (check) {
    const result = await checkGenerationSource(source, destination, { typescript });
    if (jsonMode) process.stdout.write(`${JSON.stringify(jsonEnvelope(result))}\n`);
    else {
      for (const file of result.files) process.stdout.write(`${file.status}\t${file.path}\n`);
    }
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  const files = await materializeGenerationSource(source, destination, { typescript });
  const result = { ok: true, files };
  if (jsonMode) process.stdout.write(`${JSON.stringify(jsonEnvelope(result))}\n`);
  else process.stdout.write(`Generated ${files.length} artifact(s) in ${destination}\n`);
}

async function runVerify(manifestPath, args, jsonMode, quiet) {
  const report = await verifyManifest(manifestPath, {
    planPath: optionValue(args, "--plan") ?? undefined,
    outputPath: optionValue(args, "--out") ?? undefined
  });
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(jsonEnvelope(report))}\n`);
  } else if (!quiet || !report.verified) {
    process.stdout.write(`${report.verified ? "VERIFIED" : "NOT VERIFIED"}\n`);
    process.stdout.write(
      `Bindings\t${report.bindings.verified}/${report.bindings.required} verified\n`
    );
    if (report.generator) {
      process.stdout.write(
        `Generator\t${report.generator.passed ? "matched" : "FAILED OR DRIFTED"}\n`
      );
    }
    for (const test of report.tests) {
      process.stdout.write(
        `Test ${test.ref}\t${test.passed ? "passed" : "FAILED"}\t${test.duration_ms} ms\n`
      );
    }
    process.stdout.write(`Report SHA-256\t${report.report_sha256}\n`);
  }
  process.exitCode = report.verified ? 0 : 1;
}

async function runContext(projectPath, jsonMode, quiet) {
  const context = await buildAgentContext(projectPath ?? process.cwd());
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(jsonEnvelope(context))}\n`);
  } else if (!quiet || !context.ok) {
    process.stdout.write(
      [
        `${context.application?.name ?? "Unknown application"}`,
        `Profile\t${context.profile_path}`,
        `Registry sources\t${context.registry.source_paths.length}`,
        `Actions\t${context.actions.length}`,
        `Surfaces\t${context.surfaces.length}`,
        `Manifest\t${context.manifest.valid ? "valid" : "INVALID"}`,
        `Complete with\t${context.agent_policy.completion_command.join(" ")}`
      ].join("\n") + "\n"
    );
  }
  process.exitCode = context.ok ? 0 : 1;
}

async function runDoctor(projectPath, jsonMode, quiet) {
  const report = await doctorProject(projectPath ?? process.cwd());
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(jsonEnvelope(report))}\n`);
  } else if (!quiet || !report.ok) {
    const tauri = report.observations.tauri.summary;
    const compatibility = report.observations.compatibility_summary;
    process.stdout.write(
      [
        `${report.ok ? "DOCTOR COMPLETE" : "DOCTOR FOUND BLOCKERS"}\t${report.project.name}`,
        `Git\t${report.project.git?.commit?.slice(0, 12) ?? "not detected"}\t${report.project.git?.dirty ? "DIRTY" : "clean"}`,
        `Tauri\t${tauri.unique_defined_commands} commands\t${tauri.invoke_call_sites} invoke sites`,
        `Action IDs\t${new Set(report.observations.action_ids.map((item) => item.id)).size} observed`,
        `Manifests\t${report.observations.manifests.length}`,
        `Compatibility profiles\t${compatibility.profiles}\t${compatibility.actions} actions\t${compatibility.lines_per_action} lines/action`,
        `Tests\t${report.observations.tests.definitions} definitions`,
        "",
        ...report.findings.map((finding) => `${finding.severity.toUpperCase()}\t${finding.code}\t${finding.message}`),
        "",
        ...report.next_steps.map((step) => `NEXT P${step.priority}\t${step.code}\t${step.action}`)
      ].join("\n") + "\n"
    );
  }
  process.exitCode = report.ok ? 0 : 1;
}

async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const quiet = args.includes("--quiet") || args.includes("-q");
  const positional = positionalArgs(args);

  if (positional.length === 1 && positional[0] === "--version") {
    if (jsonMode) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          data: {
            toolchain_version: VERSION,
            manifest_spec_version: MANIFEST_SPEC_VERSION,
            supported_manifest_spec_versions: SUPPORTED_MANIFEST_SPEC_VERSIONS
          },
          error: null
        })}\n`
      );
    } else {
      process.stdout.write(`${VERSION}\n`);
    }
    return;
  }
  const [mode, input] = positional;
  if (!mode || !["validate", "report", "generate", "verify", "context", "doctor"].includes(mode)) {
    failUsage("Expected validate, report, generate, verify, context, or doctor.", jsonMode);
    return;
  }
  if (!["context", "doctor"].includes(mode) && !input) {
    failUsage(`${mode} requires an input path.`, jsonMode);
    return;
  }

  try {
    if (mode === "context") {
      await runContext(input, jsonMode, quiet);
    } else if (mode === "doctor") {
      await runDoctor(input, jsonMode, quiet);
    } else if (mode === "validate" || mode === "report") {
      await runStatic(mode, input, jsonMode, quiet);
    } else if (mode === "generate") {
      await runGenerate(
        input,
        optionValue(args, "--out-dir"),
        jsonMode,
        args.includes("--typescript"),
        args.includes("--check")
      );
    } else {
      await runVerify(input, args, jsonMode, quiet);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (jsonMode) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, data: null, error: `${mode}_failed`, message })}\n`
      );
    } else {
      process.stderr.write(`${mode} failed: ${message}\n`);
    }
    process.exitCode = 1;
  }
}

await main();
