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
pending manual review.

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
