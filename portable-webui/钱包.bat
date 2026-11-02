@echo off
rem U-DSH 设备钱包面板（余额 / 一键充值 / 换一把 / 填入已有 Key）
cd /d "%~dp0resources\app"
"%CD%\runtime\node-win-x64\node.exe" wallet-panel.cjs
if errorlevel 1 pause
