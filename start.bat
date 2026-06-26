@echo off
setlocal
set "NODE=C:\Users\user\AppData\Local\JetBrains\acp-agents\cursor\2026.06.24\dist-package\node.exe"
if not exist "%NODE%" set "NODE=node"
cd /d "%~dp0"

echo.
echo  B and J Attendance Backend
echo  --------------------------
echo  Starting server on http://localhost:3000
echo  Google Sheet + local SQLite database
echo.

start "" "http://localhost:3000/scan.html"
"%NODE%" server.js
