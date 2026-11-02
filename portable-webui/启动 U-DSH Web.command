#!/bin/bash
# U-DSH DeepSeek Harness Web 便携启动（macOS）
# 数据与凭据保存在本盘 u-dsh/data/dsh-home，随盘携带
# 若双击提示权限：请在终端执行  bash "启动 U-DSH Web.command"
cd "$(dirname "$0")/resources/app" || exit 1
if [ "$(uname -m)" = "arm64" ]; then
  NODE="runtime/node-mac-arm64/bin/node"
else
  NODE="runtime/node-mac-x64/bin/node"
fi
if [ ! -x "$NODE" ] && [ ! -e "$NODE" ]; then
  echo "[U-DSH] 未找到 Node 运行时：$NODE"
  echo "请确认 u-dsh 目录完整（缺 resources/app/runtime/node-mac-*）。"
  read -r -p "按回车退出" _
  exit 1
fi
exec "$NODE" web-launch.cjs
