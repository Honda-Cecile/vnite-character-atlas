@echo off
chcp 65001 >nul
rem Publish 1.1.0 to GitHub Releases. Safe to re-run: the same asset name is replaced.
cd /d "%~dp0..\.."
node scripts\upload-release.js --version=1.1.0
if errorlevel 1 (
  echo.
  echo [FAILED] see the lines above. Usually: no token yet, or the commit is not on GitHub.
) else (
  echo.
  echo [OK] check the Releases page on GitHub.
)
echo.
pause >nul
