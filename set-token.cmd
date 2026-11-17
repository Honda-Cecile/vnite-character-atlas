@echo off
chcp 65001 >nul
rem One-time setup: store a GitHub token in .secrets\github-token and verify write access.
rem Usage: copy the token first, then double-click this file.
rem Keep this file ASCII-only: cmd.exe mis-parses a batch file once chcp 65001 is active.
echo.
echo  1. Create a GitHub token at github.com/settings/tokens
echo     classic: tick "repo"   /   fine-grained: Contents = Read and write
echo  2. Copy it
echo  3. Come back here and press any key
echo.
pause >nul
node "%~dp0scripts\set-token.js"
if errorlevel 1 (
  echo.
  echo [FAILED] not configured, see the message above.
) else (
  echo.
  echo [OK] now double-click releases\vX.Y.Z\upload.cmd
)
echo.
pause >nul
