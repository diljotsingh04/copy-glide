@echo off
rem Builds every ClipSync target into release\v<version>\ . Double-click or run: build.cmd --server-url=https://your-server
cd /d "%~dp0"
node scripts\build-all.mjs %*
set CODE=%ERRORLEVEL%
if "%~1"=="" pause
exit /b %CODE%
