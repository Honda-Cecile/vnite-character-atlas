@echo off
chcp 65001 >nul
rem 把这一版的发布说明复制进剪贴板，网页里 Ctrl+V 粘贴到正文即可。
powershell -NoProfile -Command "Get-Content -Raw -Encoding UTF8 '%~dp0RELEASE_NOTES.md' | Set-Clipboard"
if errorlevel 1 (
  echo [失败] 没读到 RELEASE_NOTES.md
) else (
  echo [完成] 发布说明已复制到剪贴板，去网页里粘贴。
)
echo.
pause >nul
