@echo off
rem Stops every CopyGlide process running locally (servers, dev app, installed app).
cd /d "%~dp0"
node scripts\stop-all.mjs %*
if "%~1"=="" pause
