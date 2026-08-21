# ActionParity Specification

**Version:** 0.5.0 Working Draft  
**Status:** Non-normative until 1.0.0  
**Tagline:** One action. Every interface.

## 1. Conventions

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and **MAY** are to be interpreted as described in BCP 14 (RFC 2119 and RFC 8174) when, and only when, they appear in all capitals.

This working draft uses normative language to make proposals testable. A claim of conformance to a pre-1.0 draft MUST identify the exact draft version.

## 2. Purpose

Software is now written and operated by AI as well as by people. Both of those
are hard for the same reason: the behavior of an application lives inside its
interface, so building a second interface means writing the behavior again, and
driving the application means driving pixels.

ActionParity exists to answer two questions, and both answers are yes or no:

### 2.1 Can it be built once?

> A developer — human or AI — implements a meaningful behavior **once**, and the
> GUI, CLI, TUI, MCP, API, and test entry points for it follow from that single
> implementation rather than being written again per interface.

Writing the same capability three times and keeping the copies aligned is the
dominant cost of building an application that is usable by both people and
agents. It is also the cost that grows fastest under AI-assisted development,
because generating three implementations is easy and noticing that they have
drifted apart is not.

### 2.2 Can it be operated without pixels?

> An agent that has never seen the source can **discover** what the application
> does, learn each behavior's inputs, outputs, effects, and risk, **invoke** it,
> and **assert** the outcome — without a screenshot, a vision model, or a
> synthetic click.

Screen-driving remains the right tool for verifying what a person sees. It is
the wrong foundation for invoking business behavior, and an application that
offers nothing else forces every agent onto it.

An implementation either satisfies these or does not. Neither question has a
percentage in it. §14 describes an optional audit profile for teams that want a
graded path; the specification itself is binary.

The standard applies to desktop, mobile, web, embedded, and service-backed
applications. Its primary initial focus is native and desktop software, where
business behavior has historically been trapped inside GUI event handlers.

## 3. Non-goals

ActionParity does not:

- define a GUI toolkit;
- require a TUI;
- replace MCP, OpenAPI, OpenRPC, WebDriver, Appium, UI Automation, or platform accessibility APIs;
- require every visual control to become a command;
- require a GUI to spawn a CLI process;
- standardize visual design;
- grant an AI agent unrestricted authority;
- claim that headless tests replace real interface tests.

### 3.1 Applicability

A standard that only describes when to adopt it cannot be trusted about cost. Adoption is worthwhile when at least one of these is true:

- a second Surface exists or is planned;
- the product must be operable or testable by an agent;
- state or actions must synchronize across devices;
- business behavior must be verifiable without a display.

Adoption is **not** worthwhile for a single-Surface tool with stable behavior and no agent scenario. The first conversion is a net increase in code — an Action Core, a manifest, adapters, and tests replace a working click handler — and it repays only at the second Surface or the first significant behavior change. Converting such a tool to raise a conformance score is waste.

Partial adoption is a first-class outcome, not an incomplete one. An implementation MAY declare conformance for a core domain and place the rest explicitly out of scope; a large application whose upstream sync would break under full conversion SHOULD do exactly that. What conformance forbids is silence: an Action omitted without a declared exception (§8.3).

## 4. Terms

### 4.1 Action

A meaningful domain operation with a stable identifier, typed input, typed output, declared effects, and observable execution semantics.

Examples: `project.create`, `gateway.start`, `document.export`, and `account.delete`.

### 4.2 Action Core

The canonical implementation layer for Actions. It does not require a graphical session and does not contain interface-specific presentation logic.

### 4.3 Surface

An interface through which a human, program, test, or agent can invoke or observe application behavior. Surface kinds include `gui`, `tui`, `cli`, `mcp`, `api`, `ipc`, and `test`.

### 4.3.1 Shadow

A Surface considered as what it is: a projection of the Action Core onto one
platform's conventions. A shadow carries presentation, input collection, and
platform integration. It carries no behavior of its own.

The Chinese name of this standard, 影核, is this relationship in two characters —
one core, many shadows (一核多影). A window, a terminal command, and an agent
tool are three shadows of one core, not three applications that happen to agree.

### 4.4 Binding

A declared mapping from a Surface target to an Action ID.

### 4.5 Presentation-only interaction

An interaction whose effect is limited to presentation and does not perform a domain operation. Examples include expanding a panel, changing a local tab, hovering, or resizing a window.

### 4.6 State

Canonical application data observable independently of a particular Surface.

### 4.7 Event

A structured record of an Action lifecycle or State change.

### 4.8 Parity exception

A temporary or permanent, machine-readable explanation for why an Action is intentionally unavailable on a declared Surface.

## 5. One core, many shadows

This chapter is the standard. Everything after it is detail, and everything in
the optional audit profile is a way of checking it.

### 5.1 The invariant

An application conforms to ActionParity only when:

> Every meaningful Action has one canonical semantic identity and one canonical implementation path, regardless of the Surface that invokes it.

Equivalent duplicated implementations do not satisfy this requirement. A GUI handler and CLI handler that independently implement the same behavior are two sources of truth and are non-conforming.

Permitted implementation patterns include:

- GUI, CLI, and MCP shadows importing the same Action Core library;
- all shadows calling the same local runtime through IPC;
- thin platform shadows calling a shared remote Action service;
- shadows generated from the Action manifest (§5.3).

### 5.2 What a Shadow must not contain

The invariant is easy to agree with and easy to violate by accident, because
each violation looks locally reasonable. These four rules are the operational
form of it. Each is binary: an implementation either violates it or does not,
and a violation is located at a specific place in the code.

A Shadow MUST NOT contain:

1. **A second implementation of a behavior.** If deleting the Action Core would
   leave this Surface still able to perform the Action, the behavior lives in
   the shadow.
2. **A policy decision that exists only here.** Confirmation, authorization, and
   risk gating belong in the core. A destructive Action whose only guard is a
   dialog in the front end is unguarded the moment a second shadow appears — and
   the second shadow is the entire point of this standard. This is the most
   frequently violated rule and the one that has produced real defects in pilots.
3. **An independent source of truth for state.** A shadow may cache; it may not
   own. Two shadows disagreeing about state means the core was not consulted.
4. **An Action reachable only through this shadow.** A behavior available in the
   GUI and nowhere else is behavior an agent cannot use, which fails §2.2.

Presentation, input collection, formatting, platform integration, and
accessibility are shadow concerns and belong in the shadow.

### 5.3 Generating shadows from the core

§2.1 asks whether a behavior can be built once. The invariant alone does not
achieve that: an implementation can satisfy §5.1 with three hand-written
adapters that each call the same function, and pay the cost of writing and
aligning three adapters forever.

An implementation SHOULD therefore derive its shadows from a single declaration
rather than hand-write each one. Registering an Action once — its identity,
schemas, effects, and implementation — SHOULD be sufficient to produce:

- its CLI subcommand, flags, help text, and `--json` output;
- its MCP tool definition;
- its API route, where an API Surface exists;
- its manifest entry;
- its test scaffolding.

The GUI is the exception. A generated GUI is usually the wrong product, so the
GUI remains hand-built — but it MUST reach the behavior through the same
registration, and its Binding MUST name the point where it does (§12.1).

This has a consequence worth stating plainly, because it is the practical
payoff of the whole standard:

> Adding a behavior costs one implementation plus one registration. Adding a
> platform costs one shadow, not one reimplementation per behavior.

An implementation MAY generate in the other direction — declare Actions in the
manifest and generate implementation stubs — provided the manifest remains the
single source and the generated code is not edited by hand.

#### 5.3.1 Provenance

Where a manifest is generated, it SHOULD declare `generated_from`. A hand-written
manifest is a claim about code; a generated one is derived from it, and the
difference determines whether the manifest can silently drift from what ships.

A validator MUST NOT treat `generated_from` as verified. It cannot re-run a
generator it does not have. Reporting the distinction is useful; scoring it
would be another unverified claim.

## 6. Action manifest

### 6.1 Discovery

A conforming implementation MUST expose an ActionParity manifest through at least one of:

- a bundled or repository-root `action-parity.json` file;
- a non-interactive CLI command that returns the manifest;
- a local IPC method;
- an MCP resource or tool;
- `/.well-known/action-parity` for network services.

The implementation SHOULD expose more than one mechanism when packaging permits.

### 6.2 Required top-level fields

The manifest MUST include:

- `spec_version`;
- `application`;
- `surfaces`;
- `actions`.

The manifest MUST validate against the schema associated with its declared draft version.

### 6.3 Application identity

`application.id` MUST remain stable across application releases. A reverse-domain identifier is RECOMMENDED.

`application.version` MUST identify the version whose implementation is described.

### 6.4 Surface declaration

Every Surface referenced by a Binding MUST be declared in `surfaces`.

A Surface with `required_for_parity: true` is one this implementation commits to keeping in parity with the core. The optional audit profile counts coverage over these Surfaces.

A machine Surface declared with `required_for_parity: false` MUST state `exclusion_reason`, and a conformance report MUST list every excluded machine Surface. Demoting a Surface removes it from the parity denominator, which raises coverage without changing the product. The Surface hardest to prove is frequently the one whose proof carries §5 — a Surface that cannot be tested alongside the GUI is precisely the Surface that cannot show they reach the same Action Core. Exclusion remains permitted; concealing it does not.

A GUI Surface SHOULD declare a `test_driver`, such as `windows-uia`, `appium`, `webdriver`, `xcuitest`, or a project-specific driver.

## 7. Action requirements

### 7.1 Identity

Every Action MUST have a unique, stable `id`.

Action IDs SHOULD use lower-case dotted namespaces:

```text
resource.verb
resource.subresource.verb
```

Renaming or changing the meaning of an Action ID is a breaking change.

### 7.2 Description and schemas

Every Action MUST declare:

- a human-readable title;
- a precise description;
- an input JSON Schema;
- an output JSON Schema.

Inputs MUST NOT depend on an interactive prompt. A Surface MAY collect input interactively, but it MUST convert the result into the declared Action input.

### 7.3 Headless execution

Every business Action MUST execute without a visible interface. This is not a graded requirement: an Action that needs a window is an Action no agent can invoke, which fails §2.2.

An Action MAY depend on platform services, devices, or user sessions when those dependencies are declared. A dependency on a visible GUI solely because business logic resides in a click handler is non-conforming.

### 7.4 Execution semantics

Every Action MUST declare:

- whether it is idempotent;
- whether it is cancellable;
- a finite default timeout;
- effect class;
- risk level;
- reversibility;
- confirmation policy;
- audit requirement.

Long-running Actions SHOULD support progress events and cancellation.

### 7.5 Structured result

Machine Surfaces MUST return a structured result equivalent to:

```json
{
  "ok": true,
  "execution_id": "exec_01H...",
  "data": {},
  "error": null,
  "meta": {
    "duration_ms": 42
  }
}
```

Failures MUST include a stable error code and a human-readable message. Secrets and sensitive values MUST NOT appear in errors, logs, manifests, or command histories.

## 8. Surface parity

### 8.1 Meaningful GUI actions

Every meaningful Action reachable through a GUI Surface MUST have a Binding to its stable Action ID.

The GUI MUST invoke the canonical Action Core. It MUST NOT maintain an independent implementation of the same domain behavior.

### 8.2 Machine access

Every meaningful GUI Action MUST have at least one non-visual machine Surface unless a documented parity exception applies.

Machine Surface kinds are `cli`, `mcp`, `api`, and `ipc`. A `test` Surface is **not** a machine Surface: an adapter reachable only from the build system demonstrates headless execution, but it is not an interface another program or agent can use. Declare it as `headless_evidence` instead.

#### 8.2.1 Reachability

Every Surface has a reachability, declared as `reachability` or defaulted:

| Value | Meaning |
|---|---|
| `in-process` | Only the application's own process or webview can invoke it |
| `local-ipc` | Another process on the same machine can invoke it |
| `external` | Another host can invoke it |

Defaults when `reachability` is absent: `cli` and `api` are `external`, `mcp` is `local-ipc`, and `ipc` and `test` are **`in-process`**. The ambiguous case fails closed, because a webview command bridge — `#[tauri::command]`, `ipcRenderer`, and equivalents — is callable only from the application's own front end. Such an implementation MUST declare a higher reachability explicitly, and that declaration is a factual claim about the product.

An implementation MUST provide, for every non-exempt Action, at least one machine Surface whose reachability is not `in-process`. An application whose only non-visual Surface is its own command bridge has not achieved machine access; it has a private calling convention.

### 8.3 Exceptions

A parity exception MUST include:

- affected Action;
- affected Surface;
- reason;
- owner;
- review or expiry date.

Exceptions MUST be included in conformance reports and MUST reduce the strict parity score. A project MUST NOT silently omit missing bindings.

### 8.4 Pure interface interactions

Presentation-only interactions do not require Action IDs. They MUST remain testable through an appropriate UI or accessibility driver when they affect usability.

## 9. CLI profile

An implementation claiming an ActionParity CLI Surface:

- MUST support a structured JSON mode;
- MUST support non-interactive execution;
- MUST keep result data on stdout;
- MUST keep logs, progress, and diagnostics on stderr;
- MUST suppress ANSI color, spinners, and dynamic progress when stdout is not a TTY;
- MUST use exit code `0` for success, `1` for runtime or conformance failure, and `2` for invalid usage;
- SHOULD support `--json`, `--quiet`, `--verbose`, `--no-input`, `--yes`, and `--version`;
- MUST NOT require secrets as command-line arguments when a safer channel is available.

For streams, JSON Lines is RECOMMENDED. Every line MUST be a complete JSON value.

## 10. State and events

### 10.1 Canonical state

Surfaces MUST observe the same canonical State after an Action completes.

A CLI or MCP invocation that changes State MUST become visible to an open GUI without requiring a separate duplicated write path. Refresh, subscription, or event-driven synchronization MAY be used.

### 10.2 Lifecycle events

Long-running Actions SHOULD emit:

```text
action.accepted
action.started
action.progress
action.completed
action.failed
action.cancelled
```

Events MUST carry an `execution_id`, `action_id`, timestamp, and relevant structured payload.

### 10.3 External truth sources

§10.1 governs Surfaces of one application. Real drift is rarely that tidy: two
separate products routinely write the same configuration file, and neither
manifest mentions the other.

An implementation MUST declare, in `state.external_resources`, every truth source
outside the application that its Actions read or write:

```jsonc
"state": {
  "external_resources": [
    {
      "path": "~/.claude/settings.json",
      "access": "read-write",
      "exclusive": false,
      "concurrency": "optimistic"
    }
  ]
}
```

`exclusive: false` states that another product may write the same resource. For
any such resource that this application writes, `concurrency` is REQUIRED:

| Value | Meaning |
|---|---|
| `last-writer-wins` | A concurrent write is overwritten without detection |
| `optimistic` | Writes carry the observed version and fail with a conflict when it moved |
| `advisory-lock` | Writers cooperate through a lock other writers may ignore |
| `exclusive-lock` | Writers are serialized by an enforced lock |

Last-writer-wins MUST NOT be an undeclared default. It is a legitimate choice
for low-value state and a data-loss defect for shared configuration, and the
difference is only visible when someone writes it down. A validator MUST report
`last-writer-wins` on a shared written resource as a warning.

An Action that writes a shared resource SHOULD carry the version it observed and
return a conflict rather than overwrite a newer one. A future draft will specify
that field for cross-device synchronization; declaring the policy here is what
makes the gap visible in the meantime.

### 10.4 Correlation and audit

Every state-changing Action SHOULD be traceable from request through result, events, logs, and audit record using the same `execution_id`.

## 11. Safety and authority

### 11.1 Least privilege

Machine Surfaces MUST NOT silently grant more authority than the corresponding human Surface.

### 11.2 Confirmation

Confirmation policy MUST be enforced below the presentation layer. A prompt instruction alone is not an adequate safety boundary.

High-risk, destructive, financial, or externally visible Actions MUST use `conditional` or `always` confirmation unless a stronger, explicitly documented policy authorizes unattended execution.

### 11.3 Sandboxed tests

Conformance and integration tests MUST NOT silently operate on real user state.

Test harnesses SHOULD support:

- isolated configuration and data directories;
- deterministic fixtures;
- dry-run where meaningful;
- cleanup and rollback;
- network and filesystem boundaries;
- explicit destructive-test opt-in.

### 11.4 Credentials

Credentials MUST remain outside manifests and test fixtures. An Action implementation MUST redact secrets from structured results and diagnostics.

## 12. GUI testability and accessibility

A GUI Surface that publishes real-interface evidence:

- MUST expose a semantic accessibility or automation tree where the platform supports one;
- MUST provide stable automation identifiers for meaningful interactive controls;
- MUST provide accessible names, roles, values, enabled state, and focus behavior;
- SHOULD prefer semantic platform controls over coordinate-only or canvas-only controls;
- MUST include binding tests proving that representative GUI controls invoke the declared Action IDs;
- MUST include real-GUI journey tests for critical workflows;
- SHOULD include visual assertions for layout-sensitive states.

Coordinate injection and screenshot reasoning MAY be used as fallbacks, but MUST NOT be the only evidence when semantic automation is available.

### 12.1 Binding target for generated interfaces

Control-level automation identifiers are natural in native toolkits, where a control has a stable identity. In a rendered interface — React, Vue, or any other component tree — controls are produced by render functions and have no inherent identity, and adding identifiers to every control is pure overhead if nothing consumes them.

For such Surfaces, a Binding MAY target the Surface's single call chokepoint instead of a control:

```text
src/lib/api/providers.ts#switchProvider
```

This is conforming when the chokepoint is the *only* path from that Surface to the Action, which is exactly the property §5 requires. Control-level identifiers remain required for real-interface evidence, because a journey test has to reach the control a person actually clicks.

## 13. Testing model

ActionParity defines four complementary test classes.

### 13.1 Action contract tests

Validate schemas, success and failure behavior, idempotency claims, timeouts, cancellation, effects, and state transitions.

### 13.2 Binding tests

Prove that each declared Surface target resolves to and invokes the expected Action ID.

### 13.3 State synchronization tests

Invoke an Action through one Surface and observe the result through another.

### 13.4 Real-interface tests

Validate accessibility, focus, interaction, visual state, platform integration, and critical end-to-end journeys.

Passing only Action contract tests does not prove GUI conformance. Passing only real-interface tests does not prove semantic parity.

## 14. Conformance and audit

Conformance is defined by §5 and is binary: an implementation either has one
Action Core with shadows that carry no behavior of their own, or it does not.
A validator reports violations and their locations. It does not grade.

Some teams want a staged path, and an external claim needs something to name.
The graded levels AP-1 through AP-4 and the coverage percentages that support
them are therefore an **optional audit profile**, published separately in
[docs/AUDIT-PROFILE.md](docs/AUDIT-PROFILE.md).

An implementation MAY conform to this specification and never produce a level
or a score. An implementation MUST NOT present a level as evidence that §5.2 is
satisfied; levels measure declared coverage, and §5.2 violations are located in
code.

## 15. Versioning

The specification follows semantic versioning.

- Patch versions clarify wording or fix schemas without changing conformance meaning.
- Minor versions may add backward-compatible fields and requirements before 1.0.
- Major versions may change normative requirements or compatibility.

Applications MUST declare the exact specification version used for a conformance claim.

## 16. Relationship to other standards

ActionParity SHOULD reuse:

- JSON Schema for Action contracts;
- MCP for agent tool discovery and invocation;
- OpenAPI or OpenRPC for service interfaces;
- platform accessibility and UI automation APIs for interface inspection;
- WebDriver or Appium where applicable;
- OpenTelemetry-compatible identifiers and traces where practical.

ActionParity defines the application parity invariant and conformance model that those technologies do not individually mandate.

## 17. Open issues before 1.0

The working group must resolve:

- canonical manifest discovery across packaged desktop and mobile applications;
- signature and provenance format for published conformance reports;
- standard error taxonomy;
- standard effect and risk taxonomy;
- capability negotiation and partial Surface support;
- compatibility rules for generated adapters;
- certification mark and trademark governance;
- normative accessibility requirements per platform;
- test evidence format and reproducibility requirements.

