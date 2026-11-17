@echo off
chcp 65001 >nul
rem 一次性配置：把 GitHub token 存进 .secrets\github-token 并当场验证写权限。
rem 用法：先复制 token，再双击本文件。
echo.
echo  1) 去 GitHub 生成 token（classic 勾 repo / fine-grained 勾 Contents: Read and write）
echo  2) 复制它
echo  3) 回到这个窗口按任意键
echo.
pause >nul
node "%~dp0scripts\set-token.js"
if errorlevel 1 (
  echo.
  echo [失败] 没配上，看上面的提示。
) else (
  echo.
  echo [完成] 现在可以双击 releases\v版本号\upload.cmd 了。
)
echo.
pause >nul
