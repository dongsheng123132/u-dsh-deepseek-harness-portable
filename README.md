# U-DSH Portable — DeepSeek Harness USB Portable Edition

**U-DSH Portable** is a Windows USB-portable distribution of DeepSeek Harness. It reuses the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and the community [deepseek-harness-desktop](https://github.com/steven-kid/deepseek-harness-desktop), adding only portable storage boundaries, a versioned kernel manager, the Xiapan Cloud device wallet, and a headless action interface.

> The first release targets Windows x64. U-DSH Portable is unofficial and does not modify the DSH Web UI or duplicate its business logic.

[简体中文](README.zh-CN.md)

## Thin shell, replaceable kernel

DSH is evolving quickly, so U-DSH keeps durable USB data separate from high-churn host caches:

| Location | Contents | Travels with USB |
|---|---|---|
| `U-DSH/data/dsh-home/` | DSH config, sessions, skills, and state | Yes |
| `U-DSH/data/u-dsh-state/device-wallet.json` | Five-field wallet transaction state | Yes |
| `%LOCALAPPDATA%/U-DSH/` | Electron cache, logs, and the kernel activation pointer | No |

The kernel (a pinned Node runtime plus the full `@deepseek-ai/dsh` dependency closure) is vendored into the release package at build time by `npm run prepare:vendor`. End-user machines never run npm and never download a byte: startup only resolves and validates the bundled kernel (package identity/version/entry/required-peer checks, milliseconds, fully offline). [`config/runtime-channel.json`](config/runtime-channel.json) is the single version source; the Node archive is SHA-256 verified and the DSH root package integrity is checked against official npm metadata — both at build time. Update checking reports npm tags but never installs anything; when the network is unreachable it degrades to "unknown" without failing startup. See [`docs/vendored-kernel.md`](docs/vendored-kernel.md).

## Device wallet

The first online launch requests a random Xiapan Cloud key, stores wallet state on the USB drive, and configures DSH through one `.credentials.yaml`/`settings.yaml` adapter. The wallet UI supports balance checks, copy, recharge, verified key adoption, two-phase key rotation, and local-only wallet removal.

Xiapan Cloud is the ready-to-use default for new users, not an exclusive provider. The official DSH provider settings remain available for DeepSeek's official API or other OpenAI-compatible services, and an existing non-Xiapan default provider is never overwritten.

Storage corruption, a read-only USB drive, or temporary network failure does not block DSH startup. Administrative secrets and balance authority must remain server-side because all client code is inspectable.

## Machine interface (ActionParity)

GUI and CLI share one headless action core. The Windows package includes `U-DSH-CLI.cmd` at its root:

```powershell
.\U-DSH-CLI.cmd list --json
.\U-DSH-CLI.cmd wallet.status --json
.\U-DSH-CLI.cmd kernel.status --json
.\U-DSH-CLI.cmd kernel.check_updates --json
```

Secrets are rejected in command-line flags and ordinary JSON output. Adopt a key through stdin or a file:

```powershell
'{"apiKey":"sk-..."}' | .\U-DSH-CLI.cmd wallet.key.adopt --input-json - --json
```

Destructive CLI actions require an explicit `--yes`.

## Develop and build

Node.js 22+ is required:

```powershell
npm install
npm test
npm run action-parity:check-generated
npm run action-parity:verify
npm run shadowfork:contract
npm run prepare:vendor   # build machine only: stages the Node runtime + DSH closure into vendor/
npm run dist:portable    # gated by prepare-vendor --check; refuses to build a shell without the kernel
```

The result is `dist/U-DSH-DeepSeek-Harness-Portable-<version>-Windows-x64.zip`. Building the vendor closure requires network access on the build machine; the packaged app runs fully offline (device-wallet features excepted).

## Forking with ShadowFork

- [`.shadowfork/profile.yaml`](.shadowfork/profile.yaml) records U-DSH's customizations relative to the community desktop upstream.
- [`.shadowfork/upstream.yaml`](.shadowfork/upstream.yaml) publishes U-DSH's downstream derivation contract: identity fields, protected boundaries, extension points, and attribution.

Prefer additions under [`src/extensions/`](src/extensions/), update kernels through the channel config, and regenerate rather than manually edit ActionParity outputs.

## Sources and licenses

The desktop base and official DSH are MIT-licensed. The vendored ActionParity snapshot is retained under Apache-2.0. See [NOTICE.md](NOTICE.md) and [third-party-licenses](third-party-licenses) for attribution.
