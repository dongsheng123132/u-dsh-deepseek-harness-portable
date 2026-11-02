#!/bin/bash
# U-DSH 设备钱包面板（余额 / 一键充值 / 换一把 / 填入已有 Key）
cd "$(dirname "$0")/resources/app" || exit 1
if [ "$(uname -m)" = "arm64" ]; then NODE="runtime/node-mac-arm64/bin/node"; else NODE="runtime/node-mac-x64/bin/node"; fi
exec "$NODE" wallet-panel.cjs
