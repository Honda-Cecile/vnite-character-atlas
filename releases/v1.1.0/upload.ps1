# Publish 1.1.0 to GitHub Releases. Safe to re-run.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Resolve-Path (Join-Path $here '..\..'))
node scripts/upload-release.js --version=1.1.0
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "[FAILED] see the lines above." -ForegroundColor Red
} else {
  Write-Host ""
  Write-Host "[OK] check the Releases page on GitHub." -ForegroundColor Green
}
Read-Host "Press Enter to close" | Out-Null
