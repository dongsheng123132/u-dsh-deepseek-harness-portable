# U-DSH Portable — DeepSeek Harness Portable / USB Edition for Windows

> **No-install portable build of DeepSeek Harness (DSH)**: unzip and run. **No Node.js, no npm, no
> kernel download.** Drop it on a USB stick or external drive, double-click on any Windows PC, and
> your sessions, credentials and workspace travel with the folder — nothing lands on `C:`.

**What makes it different: it comes with credit. No API key signup required.**

Every other DSH portable/desktop build asks you to register at platform.deepseek.com, top up, copy an
API key and paste it back — the steepest drop-off in the whole funnel. U-DSH ships the **Xiapan Cloud
device wallet**: on first launch it issues a key for this device and wires it up automatically, so you
can **just start chatting**. Top up with one click, or swap in your own key any time.

[简体中文](README.zh-CN.md) · [Download latest](../../releases/latest) · [FAQ](#faq)

## Features

- ✅ **Zero-install portable** — bundled Node.js runtime plus the complete `@deepseek-ai/dsh`
  dependency closure; the target machine needs nothing preinstalled
- ✅ **Works offline** — the kernel ships inside the package; first launch needs no network
- ✅ **Credit out of the box** — device wallet, no signup, no API key hunting
- ✅ **USB portable** — sessions, settings, credentials and workspace all live next to the executable
- ✅ **Leaves no trace** — no registry writes, no environment changes, nothing in `%USERPROFILE%`
- ✅ **Headless-callable** — every business action has a stable Action ID for CLI / MCP / API
  (ActionParity AP-2)
- ✅ **MIT licensed** — the client is fully auditable and self-buildable

## Quick start

1. Grab `U-DSH-DeepSeek-Harness-Portable-*-Windows-x64.zip` from [Releases](../../releases/latest)
2. Unzip to a USB stick, external drive or local folder (**USB drives must be NTFS** — see [FAQ](#faq))
3. Double-click `U-DSH Portable.exe`

> ⏳ **First unzip is slow.** The package contains tens of thousands of small files; on a slow drive
> this can take upwards of ten minutes. Startup afterwards is instant. Unzip to a local disk first,
> confirm it runs, then copy the folder to your USB drive.

## Scope

**Windows x64 only** for now. macOS and Linux are not supported — those build targets are gated off so
a kernel-less package can never be produced by accident.

U-DSH Portable is unofficial. It does not modify the DSH Web UI or duplicate its business logic; it
reuses the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and the
community [deepseek-harness-desktop](https://github.com/steven-kid/deepseek-harness-desktop), adding
only portable data boundaries, the vendored kernel, the device wallet and a headless action interface.

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

## FAQ

**Why must the USB drive be NTFS? Won't exFAT work?**
It won't. DSH creates a directory junction under its data directory on every launch, and
exFAT/FAT32 cannot hold one — it fails with `EISDIR`. U-DSH probes for this before starting and tells
you to switch to NTFS instead of throwing a raw error at you. Back up the drive before reformatting.

**Why is the first unzip so slow?**
The package carries DSH's full dependency closure — tens of thousands of small files. The bottleneck
is file count, not size, so a slow drive can take ten minutes or more. That is the price of "nothing
to install, works offline": we ran the install at build time so you never have to. Every launch after
that is instant.

**Can I use my own API key instead of your credit?**
Yes. The wallet page has a "use an existing key" option, and you can switch back at any time.

**Does it write anything to my machine?**
No registry writes, no environment changes. Sessions, settings, credentials and workspace all live
next to the executable — deleting the folder is a complete uninstall. (Electron's own window cache and
logs go to the system cache directory and contain no credentials.)

**Something broke — how do I report it? Where are the logs?**
Right-click the tray icon -> "Report a problem", or use the button on the wallet page. It gathers
the version, kernel status and a log excerpt (**keys redacted**) and opens a pre-filled GitHub
issue; just add a sentence describing what happened. To read the logs yourself: `Win + R` ->
`%LOCALAPPDATA%\U-DSH\logs`. They live in the system cache directory and do **not** travel with the USB drive
(they contain no credentials).

**Is this official?**
No. This is an independent community distribution, not affiliated with DeepSeek.

## Sources and licenses

U-DSH Portable is **MIT licensed** — use, modify, sell and redistribute the client freely.
The desktop base and official DSH are MIT-licensed; the vendored ActionParity snapshot is retained
under Apache-2.0. The release package includes libvips (LGPL-3.0-or-later), shipped as replaceable
standalone DLLs. See [NOTICE.md](NOTICE.md) and [third-party-licenses](third-party-licenses) for full
attribution and verbatim license texts.

### Trademarks

The MIT license covers the **code**, not the names or logos.
**U-DSH**, **U-Claw**, **Xiapan Cloud / 虾盘云** and the associated icons are project trademarks and
are *not* granted along with the code license.

Fork it, modify it, sell it — but please **ship under your own name and icon**. Don't distribute your
build as U-DSH or Xiapan Cloud: users would mistake it for this project and send you our support load
(and us yours). Xiapan Cloud credit is served only to official builds.
