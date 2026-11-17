import io
import re

p = 'scripts/stage-release.js'
s = io.open(p, encoding='utf-8').read()

# ── uploadCmd：改成纯 ASCII（cmd 在 chcp 65001 之后读多字节内容会错位，实测把 rem 行截断成命令）
start = s.index('const uploadCmd = `@echo off')
end = s.index('`\n\nconst uploadPs1', start) + 1
new_upload_cmd = '''const uploadCmd = `@echo off
chcp 65001 >nul
rem Publish ${version} to GitHub Releases. Safe to re-run: the same asset name is replaced.
cd /d "%~dp0..\\\\.."
node scripts\\\\upload-release.js --version=${version}
if errorlevel 1 (
  echo.
  echo [FAILED] see the lines above. Usually: no token yet, or the commit is not on GitHub.
) else (
  echo.
  echo [OK] check the Releases page on GitHub.
)
echo.
pause >nul
`'''
s = s[:start] + new_upload_cmd + s[end:]

# ── uploadPs1：同样纯 ASCII（PS 5.1 无 BOM 时按 ANSI 读，中文会乱）
start = s.index('const uploadPs1 = `#')
end = s.index('`\n\nconst versionReadme', start) + 1
new_ps1 = '''const uploadPs1 = `# Publish ${version} to GitHub Releases. Safe to re-run.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Resolve-Path (Join-Path $here '..\\\\..'))
node scripts/upload-release.js --version=${version}
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "[FAILED] see the lines above." -ForegroundColor Red
} else {
  Write-Host ""
  Write-Host "[OK] check the Releases page on GitHub." -ForegroundColor Green
}
Read-Host "Press Enter to close" | Out-Null
`'''
s = s[:start] + new_ps1 + s[end:]

# ── copyNotesCmd：同样纯 ASCII
start = s.index("var copyNotesCmd = [")
end = s.index("].join('\\n')", start) + len("].join('\\n')")
new_copy = """var copyNotesCmd = [
  '@echo off',
  'chcp 65001 >nul',
  'rem Copy this release\\'s notes to the clipboard, then paste them into the GitHub release body.',
  "powershell -NoProfile -Command \\"Get-Content -Raw -Encoding UTF8 '%~dp0RELEASE_NOTES.md' | Set-Clipboard\\"",
  'if errorlevel 1 (',
  '  echo [FAILED] could not read RELEASE_NOTES.md',
  ') else (',
  '  echo [OK] notes are in the clipboard - paste them in the browser.',
  ')',
  'echo.',
  'pause >nul',
  ''
].join('\\n')

// cmd.exe 会在 chcp 65001 之后按字节读文件，多字节内容会让行错位（实测 rem 行被截断成命令）。
// 所以 .cmd / .ps1 一律只写 ASCII，中文说明留在 README 里。
for (var badFile of ['upload.cmd', 'upload.ps1', '2-复制发布说明.cmd']) {
  var text = badFile === 'upload.cmd' ? uploadCmd : badFile === 'upload.ps1' ? uploadPs1 : copyNotesCmd
  if (/[^\\x00-\\x7F]/.test(text.replace(/2-复制发布说明\\.cmd/g, ''))) {
    throw new Error(badFile + ' 里出现非 ASCII 字符，cmd/PowerShell 会解析错乱')
  }
}"""
s = s[:start] + new_copy + s[end:]

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('patched stage-release.js')
