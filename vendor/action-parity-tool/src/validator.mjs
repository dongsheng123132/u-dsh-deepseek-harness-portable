import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const schemaUrl = new URL("../schema/action-parity.schema.json", import.meta.url);
const schema = JSON.parse(readFileSync(schemaUrl, "utf8"));
const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  validateFormats: false
});
const validateSchema = ajv.compile(schema);

// `test` is deliberately absent. A test adapter reachable only from the build
// system is evidence that an Action runs headlessly, not an interface an agent
// or another program can use.
const MACHINE_SURFACE_KINDS = new Set(["cli", "mcp", "api", "ipc"]);

// Reachability defaults are the honest reading of each kind, and fail closed on
// the ambiguous one: a Tauri or Electron `ipc` Surface is callable only from the
// application's own webview unless the implementation states otherwise.
const DEFAULT_REACHABILITY = {
  cli: "external",
  api: "external",
  mcp: "local-ipc",
  ipc: "in-process",
  test: "in-process"
};

function reachabilityOf(surface) {
  return surface?.reachability ?? DEFAULT_REACHABILITY[surface?.kind] ?? "in-process";
}

function isExternallyReachable(surface) {
  return MACHINE_SURFACE_KINDS.has(surface?.kind) && reachabilityOf(surface) !== "in-process";
}

function issue(severity, code, path, message) {
  return { severity, code, path, message };
}

// SPEC §5.2 violations are the primary output. They are binary and located.
// Everything else a validator emits is an annotation on this list.
const SHADOW_VIOLATION_CODES = new Set([
  "machine_surface_missing",
  "machine_surface_in_process_only",
  "unsafe_confirmation_policy",
  "shared_resource_concurrency_undeclared",
  "action_not_headless"
]);

// Not violations: places the manifest asserts something it cannot demonstrate.
// Kept apart from violations because the remedy is different — a violation is
// fixed by moving code, an unproven claim is settled by writing a test.
const UNPROVEN_CODES = new Set([
  "headless_evidence_missing",
  "binding_test_missing",
  "machine_surface_excluded_without_reason",
  "shared_resource_last_writer_wins"
]);

function today() {
  return new Date().toISOString().slice(0, 10);
}

// A non-empty test reference is a declaration of evidence, not proof that the
// test exists or passed. `action-parity verify` owns the executable boundary.
function hasDeclaredTest(binding) {
  return typeof binding?.test === "string" && binding.test.trim().length > 0;
}

function addSchemaIssues(issues) {
  for (const error of validateSchema.errors ?? []) {
    issues.push(
      issue(
        "error",
        "schema_validation",
        error.instancePath || "/",
        error.message ?? "Schema validation failed."
      )
    );
  }
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return duplicates;
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function bindingsOf(action) {
  return arrayOrEmpty(action?.bindings);
}

function exceptionsOf(action) {
  return arrayOrEmpty(action?.parity_exceptions);
}

export async function readManifest(path) {
  const text = await readFile(path, "utf8");
  return JSON.parse(text);
}

export function validateManifestObject(manifest) {
  const issues = [];
  const schemaValid = validateSchema(manifest);

  if (!schemaValid) {
    addSchemaIssues(issues);
    return buildReport(manifest, issues);
  }

  const surfaceById = new Map(manifest.surfaces.map((surface) => [surface.id, surface]));
  const actionById = new Map(manifest.actions.map((action) => [action.id, action]));
  const targetLevels = new Set(manifest.conformance_targets ?? []);
  const requiredSurfaces = manifest.surfaces.filter((surface) => surface.required_for_parity);

  for (const id of duplicateValues(manifest.surfaces.map((surface) => surface.id))) {
    issues.push(issue("error", "duplicate_surface_id", "/surfaces", `Duplicate Surface ID: ${id}`));
  }

  // Demoting a Surface out of the required set is the cheapest way to raise
  // declared test coverage, and the Surface hardest to prove is usually the one whose
  // proof matters most. The denominator may shrink; it may not shrink quietly.
  for (const [surfaceIndex, surface] of manifest.surfaces.entries()) {
    if (!MACHINE_SURFACE_KINDS.has(surface.kind) || surface.required_for_parity) continue;
    if (!surface.exclusion_reason) {
      issues.push(
        issue(
          "warning",
          "machine_surface_excluded_without_reason",
          `/surfaces/${surfaceIndex}`,
          `Machine Surface ${surface.id} is excluded from parity without a stated reason; the parity denominator shrinks silently.`
        )
      );
    }
  }

  for (const id of duplicateValues(manifest.actions.map((action) => action.id))) {
    issues.push(issue("error", "duplicate_action_id", "/actions", `Duplicate Action ID: ${id}`));
  }

  if ((targetLevels.has("AP-2") || targetLevels.has("AP-3") || targetLevels.has("AP-4")) && requiredSurfaces.length === 0) {
    issues.push(
      issue(
        "error",
        "no_required_surface",
        "/surfaces",
        "AP-2 or higher requires at least one Surface with required_for_parity=true."
      )
    );
  }

  // Cross-product drift happens in shared configuration, not inside one
  // application. A resource another product can write is only safe when the
  // implementation says how a concurrent write is resolved; silence resolves it
  // as last-writer-wins without anyone choosing that.
  for (const [resourceIndex, resource] of (manifest.state?.external_resources ?? []).entries()) {
    const resourcePath = `/state/external_resources/${resourceIndex}`;
    const written = resource.access === "write" || resource.access === "read-write";

    if (written && !resource.exclusive && !resource.concurrency) {
      issues.push(
        issue(
          "error",
          "shared_resource_concurrency_undeclared",
          `${resourcePath}/concurrency`,
          `${resource.path} is written by this application and by others without a declared concurrency policy; last-writer-wins must be chosen, not inherited.`
        )
      );
    }

    if (written && !resource.exclusive && resource.concurrency === "last-writer-wins") {
      issues.push(
        issue(
          "warning",
          "shared_resource_last_writer_wins",
          `${resourcePath}/concurrency`,
          `${resource.path} is shared and resolves concurrent writes by last-writer-wins; a write from another product can be lost silently.`
        )
      );
    }
  }

  for (const [actionIndex, action] of manifest.actions.entries()) {
    const actionPath = `/actions/${actionIndex}`;
    const boundSurfaceIds = new Set();
    const exceptionSurfaceIds = new Set();

    if (!action.execution.headless) {
      issues.push(
        issue(
          "error",
          "action_not_headless",
          `${actionPath}/execution/headless`,
          `${action.id} is a business Action but is not headless.`
        )
      );
    }

    for (const [bindingIndex, binding] of action.bindings.entries()) {
      const bindingPath = `${actionPath}/bindings/${bindingIndex}`;
      const surface = surfaceById.get(binding.surface);

      if (!surface) {
        issues.push(
          issue(
            "error",
            "unknown_binding_surface",
            `${bindingPath}/surface`,
            `${action.id} references undeclared Surface ${binding.surface}.`
          )
        );
        continue;
      }

      boundSurfaceIds.add(binding.surface);

      // A machine-readable mode is spelled `--json` on POSIX, `-Json` in
      // PowerShell, and `/json` in classic Windows tools. The requirement is
      // that a caller can see how to get structured output, not that every
      // ecosystem adopt POSIX flag syntax.
      const exposesJson = /(^|\s)(--json|-json|\/json)(=|\s|$)/i.test(binding.target);

      if (surface.kind === "cli" && !exposesJson) {
        issues.push(
          issue(
            "warning",
            "cli_binding_json_not_visible",
            `${bindingPath}/target`,
            `${action.id} CLI binding does not show a machine-readable JSON mode.`
          )
        );
      }

      if (targetLevels.has("AP-4") && !binding.test) {
        issues.push(
          issue(
            "error",
            "binding_test_missing",
            bindingPath,
            `${action.id} binding for ${binding.surface} lacks an AP-4 test declaration.`
          )
        );
      }
    }

    for (const [exceptionIndex, exception] of (action.parity_exceptions ?? []).entries()) {
      const exceptionPath = `${actionPath}/parity_exceptions/${exceptionIndex}`;
      exceptionSurfaceIds.add(exception.surface);

      if (exception.review_by < today()) {
        issues.push(
          issue(
            "warning",
            "parity_exception_overdue",
            `${exceptionPath}/review_by`,
            `${action.id} exception for ${exception.surface} passed its review date ${exception.review_by}.`
          )
        );
      }

      if (!surfaceById.has(exception.surface)) {
        issues.push(
          issue(
            "error",
            "unknown_exception_surface",
            `${exceptionPath}/surface`,
            `${action.id} exception references undeclared Surface ${exception.surface}.`
          )
        );
      }

      if (boundSurfaceIds.has(exception.surface)) {
        issues.push(
          issue(
            "warning",
            "redundant_parity_exception",
            exceptionPath,
            `${action.id} has both a Binding and exception for ${exception.surface}.`
          )
        );
      }
    }

    for (const surface of requiredSurfaces) {
      if (!boundSurfaceIds.has(surface.id) && !exceptionSurfaceIds.has(surface.id)) {
        issues.push(
          issue(
            "error",
            "missing_required_binding",
            `${actionPath}/bindings`,
            `${action.id} has no Binding or declared exception for required Surface ${surface.id}.`
          )
        );
      }
    }

    const machineSurfaces = action.bindings
      .map((binding) => surfaceById.get(binding.surface))
      .filter((surface) => surface && MACHINE_SURFACE_KINDS.has(surface.kind));

    if (machineSurfaces.length === 0) {
      issues.push(
        issue(
          "error",
          "machine_surface_missing",
          `${actionPath}/bindings`,
          `${action.id} has no non-visual machine Surface.`
        )
      );
    } else if (!machineSurfaces.some(isExternallyReachable)) {
      const reached = machineSurfaces.map((surface) => `${surface.id}=${reachabilityOf(surface)}`);
      issues.push(
        issue(
          targetLevels.has("AP-2") || targetLevels.has("AP-3") || targetLevels.has("AP-4")
            ? "error"
            : "warning",
          "machine_surface_in_process_only",
          `${actionPath}/bindings`,
          `${action.id} is reachable only from inside its own application (${reached.join(", ")}); no external process or agent can invoke it.`
        )
      );
    }

    if (!action.execution.headless_evidence) {
      issues.push(
        issue(
          "warning",
          "headless_evidence_missing",
          `${actionPath}/execution`,
          `${action.id} declares headless execution without naming evidence for it.`
        )
      );
    }

    const requiresConfirmation =
      action.effects.risk === "high" ||
      action.effects.risk === "critical" ||
      action.effects.class === "destructive" ||
      action.effects.class === "financial";

    if (requiresConfirmation && action.effects.confirmation === "never") {
      issues.push(
        issue(
          "error",
          "unsafe_confirmation_policy",
          `${actionPath}/effects/confirmation`,
          `${action.id} requires conditional or always confirmation.`
        )
      );
    }

    if (
      (targetLevels.has("AP-3") || targetLevels.has("AP-4")) &&
      action.effects.class !== "read" &&
      !action.effects.audit_required
    ) {
      issues.push(
        issue(
          "error",
          "audit_required_for_state_change",
          `${actionPath}/effects/audit_required`,
          `${action.id} changes or reaches outside the application but does not require audit.`
        )
      );
    }

    if (action.effects.rollback_action && !actionById.has(action.effects.rollback_action)) {
      issues.push(
        issue(
          "error",
          "unknown_rollback_action",
          `${actionPath}/effects/rollback_action`,
          `${action.id} references missing rollback Action ${action.effects.rollback_action}.`
        )
      );
    }

    if (action.execution.timeout_ms > 300000) {
      issues.push(
        issue(
          "warning",
          "long_default_timeout",
          `${actionPath}/execution/timeout_ms`,
          `${action.id} has a default timeout longer than five minutes.`
        )
      );
    }

    if (action.execution.progress_events && !action.execution.cancellable) {
      issues.push(
        issue(
          "warning",
          "progress_without_cancellation",
          `${actionPath}/execution`,
          `${action.id} reports progress but cannot be cancelled.`
        )
      );
    }
  }

  return buildReport(manifest, issues);
}

function buildReport(manifest, issues) {
  // Schema-invalid manifests still need a useful report. Doctor and validate
  // inspect legacy projects precisely to find malformed collection shapes, so
  // the reporting path must be total instead of assuming AJV already passed.
  const surfaces = arrayOrEmpty(manifest?.surfaces);
  const actions = arrayOrEmpty(manifest?.actions);
  const requiredSurfaces = surfaces.filter((surface) => surface?.required_for_parity);
  const requiredSurfaceIds = new Set(
    requiredSurfaces.map((surface) => surface?.id).filter(Boolean)
  );

  let presentRequiredBindings = 0;
  let declaredTestBindings = 0;
  let exceptionCount = 0;
  const perSurface = requiredSurfaces.map((surface) => {
    let mappedActions = 0;
    let actionsWithDeclaredTests = 0;
    for (const action of actions) {
      const binding = bindingsOf(action).find((item) => item?.surface === surface?.id);
      if (binding) {
        mappedActions += 1;
        if (hasDeclaredTest(binding)) {
          actionsWithDeclaredTests += 1;
        }
      }
    }
    presentRequiredBindings += mappedActions;
    declaredTestBindings += actionsWithDeclaredTests;
    return {
      id: surface?.id ?? null,
      kind: surface?.kind ?? null,
      reachability: reachabilityOf(surface),
      mapped_actions: mappedActions,
      declared_test_actions: actionsWithDeclaredTests,
      total_actions: actions.length,
      coverage_percent: actions.length === 0 ? 0 : roundPercent(mappedActions, actions.length),
      declared_test_percent:
        actions.length === 0 ? 0 : roundPercent(actionsWithDeclaredTests, actions.length)
    };
  });

  for (const action of actions) {
    exceptionCount += exceptionsOf(action).filter((exception) =>
      requiredSurfaceIds.has(exception?.surface)
    ).length;
  }

  const totalRequiredBindings = actions.length * requiredSurfaces.length;
  const errors = issues.filter((item) => item.severity === "error").length;
  const warnings = issues.filter((item) => item.severity === "warning").length;

  const surfaceById = new Map(surfaces.filter((item) => item?.id).map((item) => [item.id, item]));
  const externallyReachableActions = actions.filter((action) =>
    bindingsOf(action).some((binding) =>
      isExternallyReachable(surfaceById.get(binding?.surface))
    )
  ).length;

  const summary = {
    actions: actions.length,
    surfaces: surfaces.length,
    required_surfaces: requiredSurfaces.length,
    headless_actions: actions.filter((action) => action?.execution?.headless).length,
    headless_evidence_declarations: actions.filter((action) => action?.execution?.headless_evidence)
      .length,
    externally_reachable_actions: externallyReachableActions,
    shared_external_resources: arrayOrEmpty(manifest?.state?.external_resources)
      .filter((resource) => !resource?.exclusive)
      .map((resource) => ({
        path: resource?.path ?? null,
        access: resource?.access ?? null,
        concurrency: resource?.concurrency ?? null
      })),
    excluded_machine_surfaces: surfaces
      .filter((surface) => MACHINE_SURFACE_KINDS.has(surface?.kind) && !surface?.required_for_parity)
      .map((surface) => ({
        id: surface.id,
        kind: surface.kind,
        reachability: reachabilityOf(surface),
        reason: surface.exclusion_reason ?? null
      })),
    present_required_bindings: presentRequiredBindings,
    declared_test_bindings: declaredTestBindings,
    total_required_bindings: totalRequiredBindings,
    declared_parity_percent:
      totalRequiredBindings === 0 ? 0 : roundPercent(presentRequiredBindings, totalRequiredBindings),
    declared_test_coverage_percent:
      totalRequiredBindings === 0 ? 0 : roundPercent(declaredTestBindings, totalRequiredBindings),
    declared_exceptions: exceptionCount,
    errors,
    warnings
  };

  const violations = issues.filter((item) => SHADOW_VIOLATION_CODES.has(item.code));
  const unproven = issues.filter((item) => UNPROVEN_CODES.has(item.code));

  return {
    ok: errors === 0,
    spec_version: manifest?.spec_version ?? null,
    application: manifest?.application ?? null,
    evidence: {
      status: "declared",
      message: "Static validation does not execute binding.test or headless_evidence. Run action-parity verify."
    },
    // SPEC §5.2 first. The audit block below is an optional profile.
    violations,
    unproven,
    shadows: describeShadows(manifest),
    summary,
    audit: assessConformance(manifest, summary),
    surfaces: perSurface,
    issues
  };
}

// One line per shadow. It reports what is known about each Surface, and stays
// silent about what static analysis cannot see: whether a shadow holds its own
// implementation is a property of code, not of a manifest. Saying "no behavior
// of its own" here would be the same overclaim this validator exists to catch.
function describeShadows(manifest) {
  const actions = arrayOrEmpty(manifest?.actions);
  return arrayOrEmpty(manifest?.surfaces).map((surface) => {
    const bindings = actions
      .flatMap(bindingsOf)
      .filter((binding) => binding?.surface === surface?.id);
    return {
      id: surface?.id ?? null,
      kind: surface?.kind ?? null,
      reachability: reachabilityOf(surface),
      checked: surface?.required_for_parity === true,
      actions: bindings.length,
      declared_test_bindings: bindings.filter(hasDeclaredTest).length
    };
  });
}

// Targets are what the manifest asks for. Static analysis can award AP-1 and
// report whether the AP-2 declarations are complete, but only `verify` can say
// that the named tests ran. A filename in JSON is not executed evidence.
function assessConformance(manifest, summary) {
  const targets = Array.isArray(manifest?.conformance_targets) ? manifest.conformance_targets : [];
  const actions = Array.isArray(manifest?.actions) ? manifest.actions : [];
  const surfaces = Array.isArray(manifest?.surfaces) ? manifest.surfaces : [];
  const surfaceById = new Map(surfaces.filter((item) => item?.id).map((item) => [item.id, item]));
  const blockers = [];

  const hasMachineBinding = (action) =>
    bindingsOf(action).some((binding) =>
      MACHINE_SURFACE_KINDS.has(surfaceById.get(binding?.surface)?.kind)
    );

  if (summary.errors > 0) blockers.push(`${summary.errors} validation error(s)`);
  if (actions.length === 0) blockers.push("no Actions declared");
  const notHeadless = actions.filter((action) => action?.execution?.headless !== true).length;
  if (notHeadless > 0) blockers.push(`${notHeadless} Action(s) not headless`);
  const undeclaredHeadless = actions.length - summary.headless_evidence_declarations;
  if (undeclaredHeadless > 0) {
    blockers.push(`${undeclaredHeadless} Action(s) claim headless execution without an evidence declaration`);
  }
  const noMachine = actions.filter((action) => !hasMachineBinding(action)).length;
  if (noMachine > 0) blockers.push(`${noMachine} Action(s) without a machine Surface`);

  const ap1 = blockers.length === 0;

  if (ap1) {
    const unreachable = actions.length - summary.externally_reachable_actions;
    if (unreachable > 0) {
      blockers.push(
        `${unreachable} Action(s) reachable only in-process — AP-2 needs a machine Surface an external process can invoke`
      );
    }
    if (summary.declared_parity_percent < 100) {
      blockers.push(`declared parity ${summary.declared_parity_percent}% (AP-2 needs 100%)`);
    }
    if (summary.declared_test_coverage_percent < 100) {
      blockers.push(
        `declared test coverage ${summary.declared_test_coverage_percent}% — ${
          summary.total_required_bindings - summary.declared_test_bindings
        } required Binding(s) name no test`
      );
    }
  }

  const readyForVerification = ap1 && blockers.length === 0;
  const achieved = ap1 ? "AP-1" : "none";
  if (readyForVerification) {
    blockers.push("runtime evidence has not been executed; run action-parity verify before claiming AP-2");
  }

  // AP-1 is the ceiling a static check can honestly award. AP-2 requires the
  // generator and Binding observations to execute; AP-3 additionally concerns
  // structured results, core policy, and real audit records.
  // `audit_required: true` states that an Action needs audit, not that audit
  // exists, so treating it as an AP-3 grade would repeat the mistake this
  // function was written to prevent.
  const notes = [];
  if (readyForVerification) {
    notes.push(
      "All AP-2 declarations are present. Static validation stops at AP-1; verify must execute the generator and binding tests."
    );
    const unaudited = actions.filter(
      (action) => action?.effects?.class !== "read" && action?.effects?.audit_required !== true
    ).length;
    if (unaudited > 0) {
      notes.push(
        `${unaudited} state-changing Action(s) do not declare audit_required, which blocks an AP-3 claim before runtime evidence is even considered.`
      );
    }
  }

  return { targets, achieved, blockers, notes };
}

function roundPercent(numerator, denominator) {
  return Math.round((numerator / denominator) * 1000) / 10;
}

export function schemaPath() {
  return fileURLToPath(schemaUrl);
}

