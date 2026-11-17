@echo off
chcp 65001 >nul
rem Copy this release's notes to the clipboard, then paste them into the GitHub release body.
powershell -NoProfile -Command "try { Get-Content -Raw -Encoding UTF8 '%~dp0RELEASE_NOTES.md' | Set-Clipboard -ErrorAction Stop; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  echo [WARN] clipboard is busy - opening the notes in Notepad, select all and copy from there.
  notepad "%~dp0RELEASE_NOTES.md"
) else (
  echo [OK] notes are in the clipboard - paste them in the browser.
)
echo.
pause >nul
