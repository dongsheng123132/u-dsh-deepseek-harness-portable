# U-DSH Portable — WebUI build

This directory holds the **WebUI portable build** sources: the launchers plus the cross-platform
launcher/installer scripts. Windows + macOS on exFAT/NTFS USB drives — one package for both.

## What's here

```
portable-webui/
├── 启动 U-DSH Web.bat          # Windows launcher (double-click)
├── 启动 U-DSH Web.command      # macOS launcher (double-click)
└── resources/app/
    ├── web-launch.cjs          # bootstrap: resolves/installs the engine, starts the DSH web kernel,
    │                           # parses the ready URL and opens the browser
    └── engine-install.cjs      # where the engine lives (auto/host/drive/temp/usb) + how it gets there
```

## Released package layout (v0.3.0+)

```
<root>/
├── 启动 U-DSH Web.bat / .command
├── README.md
├── data/dsh-home/                     # user data — travels with the stick
└── resources/app/
    ├── web-launch.cjs
    ├── engine-install.cjs
    ├── engine.json                    # {version, engine:"engine.tar.gz"}
    ├── engine.tar.gz                  # DSH closure (node_modules + package.json), one file
    └── runtime/node-win-x64/node.exe  # bootstrap Node — also the runtime installed to the host
        runtime/node-mac-arm64/bin/node
```

Build it with:

```bash
UDSH_VENDOR_WEB_UI=1 npm run prepare:vendor     # needs network; vendor/runtime + vendor/harness
node scripts/build-webui-package.mjs \
  --out dist/u-dsh \
  --harness vendor/harness \
  --runtime node-win-x64=vendor/runtime/win32-x64 \
  --runtime node-mac-arm64=<node-v24.19.0-darwin-arm64 dir> \
  --zip
```

`UDSH_VENDOR_WEB_UI=1` is required: the web profile bundle (`@deepseek-ai/dsh-web-app`) is not a
plain dependency of `@deepseek-ai/dsh`, and without it the kernel starts with
`cannot resolve profile bundle "@deepseek-ai/dsh-web-app"` and never prints a ready URL.

## Why the closure is one archive, not a directory tree

exFAT commonly uses 128 KB clusters; a 4 KB file still eats one cluster. Spreading the 12,057-file
closure on the stick measured **1.4 GB / ~40 minutes** to copy onto a 59 GB exFAT USB key, and then
the customer had to copy all 12,057 files off the stick again to run them.

With `engine.tar.gz` the stick holds **21 files / 234 MB**, copies in **78 seconds**, and the first
launch extracts in place on the host in **8–10 seconds** (system `tar`; Windows 10 1803+ and macOS
both ship one). Node never runs from the stick — it is installed to the host alongside the closure.

## Verification

```bash
node scripts/verify-engine-install.mjs --app <package root> --mode host  --expect-install
node scripts/verify-engine-install.mjs --app <package root> --mode host  --expect-reuse
node scripts/verify-engine-install.mjs --app <package root> --mode temp
node scripts/verify-engine-install.mjs --app <package root> --mode drive
```

It boots the real kernel, checks the ready URL over HTTP, and asserts where the engine landed, that
the manifest version matches, that data stayed in `<root>/data/dsh-home`, and that `temp` mode leaves
nothing behind after exit.

## Why the WebUI build works on exFAT

The Electron desktop build (v0.2.0) creates a directory junction under its data dir on every launch
— exFAT/FAT32 cannot hold one, so that build requires NTFS. The WebUI launcher starts the DSH web
kernel directly and never needs a junction. Verified on exFAT (32 KB and 128 KB clusters).
