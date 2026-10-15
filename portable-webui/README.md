# U-DSH Portable — WebUI build (v0.2.1)

This directory holds the **WebUI portable build** runtime wrapper — the recommended build for
Windows + macOS on exFAT/NTFS USB drives (see top-level README for the version matrix).

## What's here

```
portable-webui/
├── 启动 U-DSH Web.bat          # Windows launcher (double-click)
├── 启动 U-DSH Web.command      # macOS launcher (double-click)
└── resources/app/
    └── web-launch.cjs          # cross-platform launcher: starts the DSH web kernel with
                                # --no-open, parses the ready URL and opens the browser
```

## How the full v0.2.1 package is assembled

The released `U-DSH-WebUI-Portable-0.2.1-win-mac.zip` = **kernel closure** + **runtime** + this
wrapper, laid out as:

```
<root>/
├── 启动 U-DSH Web.bat / .command
└── resources/app/
    ├── web-launch.cjs
    ├── node_modules/            # @deepseek-ai/dsh closure (npm run prepare:vendor)
    ├── runtime/                 # bundled Node: node-win-x64 + node-mac-arm64(+x64)
    ├── src/, config/, assets/   # kernel web assets (from the repo build)
    └── package.json
```

Data lives in `resources/app/../../data/dsh-home` (i.e. `<root>/data/dsh-home` on the USB drive) and
travels with the stick.

## Why WebUI build works on exFAT

The Electron desktop build (v0.2.0) creates a directory junction under its data dir on every launch
— exFAT/FAT32 cannot hold one, so that build requires NTFS. The WebUI launcher starts the DSH web
kernel directly (`node web-launch.cjs`) and was verified on an exFAT-formatted USB drive (Windows).
exFAT is the one filesystem both Windows and macOS can read/write, so one stick serves both OSes.
