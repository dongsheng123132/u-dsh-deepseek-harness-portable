# U-DSH Portable notices

U-DSH Portable is an unofficial U-series portable distribution of DeepSeek Harness.
It is not affiliated with or endorsed by DeepSeek.

## Bundled third-party software

Since v0.2.0 this distribution ships **complete copies** of the following
third-party software inside the release package:

- the official `@deepseek-ai/dsh` runtime together with its **entire npm
  dependency closure** (several hundred packages, under `resources/harness/`);
- the official **Node.js runtime** for Windows x64 (under `resources/runtime/`);
- the **Electron** desktop runtime that hosts the application (Chromium and
  other Electron-bundled components are covered by `LICENSES.chromium.html`
  placed in the package root by the packager);
- the application's own production npm dependencies.

The full machine-generated license inventory for all of the above lives in
`third-party-licenses/`:

- `third-party-licenses/NOTICES.md` — human-readable list, one section per
  package, including the verbatim license texts;
- `third-party-licenses/manifest.json` — machine-readable manifest
  (name / version / license identifier / origin);
- `third-party-licenses/deepseek-harness-LICENSE` — the MIT license of the
  official `@deepseek-ai/dsh` runtime.

Regenerate with `npm run licenses:generate`; the release gate
`npm run licenses:check` fails if any shipped package is missing from the
inventory, lacks a license text, or carries a copyleft (GPL/AGPL/LGPL) license
that has not been explicitly adjudicated.

Where an upstream package declares a standard SPDX license but ships no license
text of its own, the standard text is supplied from
`third-party-licenses/supplements/` and is **labelled as supplied by U-DSH**, not
passed off as the upstream original.

### libvips (LGPL-3.0-or-later) — your right to replace it

This distribution includes **libvips**, the image-processing library used by
`sharp`, which DeepSeek Harness uses to handle image attachments. libvips is
licensed under the **LGPL-3.0-or-later**. It ships as two ordinary dynamic
libraries:

```
resources/harness/node_modules/@img/sharp-win32-x64/lib/libvips-42.dll
resources/harness/node_modules/@img/sharp-win32-x64/lib/libvips-cpp-8.18.3.dll
```

They are loaded dynamically at runtime by `sharp-win32-x64-0.35.3.node`
(Apache-2.0). As required by the LGPL, **you may replace libvips with your own
build**: the release package is a plain folder, so overwriting these files with
compatible libraries of the same name is sufficient — no relinking, no rebuild
of U-DSH, and nothing in this distribution prevents or restricts it.

The complete LGPL-3.0 text is included in `third-party-licenses/NOTICES.md`.
libvips upstream: <https://github.com/libvips/libvips>.

No other copyleft-licensed component is shipped.

## Provenance

The desktop host started from the MIT-licensed
`steven-kid/deepseek-harness-desktop` project and retains its copyright and
license terms in `LICENSE`.

U-DSH Portable adds portable data isolation, the Xiapan Cloud device wallet, automatic
OpenAI-compatible provider configuration, and Chinese wallet management UI.

The vendored ActionParity SDK/tooling is derived from
`dongsheng123132/action-parity` at the commit recorded in `vendor/README.md`
under Apache-2.0. The ShadowFork derivation-contract schema comes from
`dongsheng123132/shadowfork` under MIT.
