@echo off
chcp 65001 >nul
rem Publish 1.0.0: push tag if needed, then create/refresh the GitHub Release and upload the package.
rem Extra args are passed through: publish.cmd --dry-run / --no-push / --main
cd /d "%~dp0..\.."
node scripts\publish.js --version=1.0.0 %*
if errorlevel 1 (
  echo.
  echo [FAILED] see the lines above.
) else (
  echo.
  echo [OK] check the Releases page on GitHub.
)
echo.
pause >nul
