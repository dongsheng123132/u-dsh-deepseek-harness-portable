#!/bin/bash
# U-DSH 一键充值：直接打开虾盘云充值页
cd "$(dirname "$0")/resources/app" || exit 1
if [ "$(uname -m)" = "arm64" ]; then NODE="runtime/node-mac-arm64/bin/node"; else NODE="runtime/node-mac-x64/bin/node"; fi
exec "$NODE" wallet-recharge.cjs
