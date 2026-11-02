@echo off
rem U-DSH 一键充值：直接打开虾盘云充值页
cd /d "%~dp0resources\app"
"%CD%\runtime\node-win-x64\node.exe" wallet-recharge.cjs
if errorlevel 1 pause
