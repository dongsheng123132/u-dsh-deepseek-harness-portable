@echo off
rem U-DSH DeepSeek Harness Web 便携启动（Windows）
rem 数据与凭据保存在本盘 u-dsh\data\dsh-home，随盘携带
cd /d "%~dp0resources\app"
set "NODE_EXE=%CD%\runtime\node-win-x64\node.exe"
if not exist "%NODE_EXE%" (
  echo [U-DSH] 未找到 Node 运行时：%NODE_EXE%
  echo 请确认 u-dsh 目录完整（缺 resources\app\runtime\node-win-x64）。
  pause
  exit /b 1
)
"%NODE_EXE%" web-launch.cjs
if errorlevel 1 pause
