# 双击或用 PowerShell 运行：把 1.1.0 发布到 GitHub Release。可重复运行。
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Resolve-Path (Join-Path $here '..\..'))
node scripts/upload-release.js --version=1.1.0
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "[失败] 原因见上面几行。" -ForegroundColor Red
} else {
  Write-Host ""
  Write-Host "[完成] 去 GitHub 的 Releases 页面确认一下。" -ForegroundColor Green
}
Read-Host "按回车关闭" | Out-Null
