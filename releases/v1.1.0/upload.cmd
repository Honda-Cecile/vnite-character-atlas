@echo off
chcp 65001 >nul
rem 双击这个文件，把 1.1.0 发布到 GitHub Release。可以重复运行（同名附件会先删再传）。
cd /d "%~dp0..\.."
node scripts\upload-release.js --version=1.1.0
if errorlevel 1 (
  echo.
  echo [失败] 原因见上面几行。常见原因：没有 token、GitHub 上还没有这个 commit。
) else (
  echo.
  echo [完成] 去 GitHub 的 Releases 页面确认一下。
)
echo.
pause >nul
