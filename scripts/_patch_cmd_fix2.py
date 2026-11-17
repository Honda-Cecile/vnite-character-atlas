import io

# ── 1. upload-release.js：GitHub 对「不存在的 commit sha」返回 422，不是 404 ──
p = 'scripts/upload-release.js'
s = io.open(p, encoding='utf-8').read()
old = """  if (check.status === 404) {
    die(
      `GitHub 上找不到 commit ${fullSha.slice(0, 7)}`,"""
new = """  if (check.status === 404 || check.status === 422) {
    die(
      `GitHub 上找不到 commit ${fullSha.slice(0, 7)}`,」""".replace('」', '')
assert old in s
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)

# ── 2. 剪贴板失败时退回记事本，别只抛一条 PowerShell 红字 ──
p = 'scripts/stage-release.js'
s = io.open(p, encoding='utf-8').read()
old = """  "powershell -NoProfile -Command \\"Get-Content -Raw -Encoding UTF8 '%~dp0RELEASE_NOTES.md' | Set-Clipboard\\"",
  'if errorlevel 1 (',
  '  echo [FAILED] could not read RELEASE_NOTES.md',
  ') else (',
  '  echo [OK] notes are in the clipboard - paste them in the browser.',
  ')',"""
new = """  'powershell -NoProfile -Command "try { Get-Content -Raw -Encoding UTF8 \\'%~dp0RELEASE_NOTES.md\\' ^| Set-Clipboard -ErrorAction Stop; exit 0 } catch { exit 1 }"',
  'if errorlevel 1 (',
  '  echo [WARN] clipboard is busy - opening the notes in Notepad, select all and copy from there.',
  '  notepad "%~dp0RELEASE_NOTES.md"',
  ') else (',
  '  echo [OK] notes are in the clipboard - paste them in the browser.',
  ')',"""
assert old in s
s = s.replace(old, new, 1)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('patched')
