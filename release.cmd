@echo off
chcp 65001 >nul
rem One click: typecheck-free full pipeline = build + pack + stage into releases\v<version>\.
rem Change the version in package.json first, then double-click this.
cd /d "%~dp0"
call npm run release
if errorlevel 1 (
  echo.
  echo [FAILED] see the lines above.
) else (
  echo.
  echo [OK] staged. Now double-click releases\v<version>\publish.cmd to upload it.
)
echo.
pause >nul
