@echo off
chcp 65001 >nul
rem Publish the version in package.json.
rem The version must be staged first: releases\vX.Y.Z\ (run release.cmd, or npm run release).
rem Extra args pass through: publish.cmd --dry-run / --no-push / --main
cd /d "%~dp0"
node scripts\publish.js %*
if errorlevel 1 (
  echo.
  echo [FAILED] see the lines above.
) else (
  echo.
  echo [OK] check the Releases page on GitHub.
)
echo.
pause >nul
