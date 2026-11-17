import io

p = 'scripts/stage-release.js'
s = io.open(p, encoding='utf-8').read()

old_row = "| \\`upload.cmd\\` | **双击就能上传**（Windows）。可重复运行，同名附件会先删再传 |"
new_rows = (
    "| \\`1-打开发布页.url\\` | **最省事**：双击直接打开预填好 tag 与标题的 GitHub 新建 Release 页 |\n"
    "| \\`2-复制发布说明.cmd\\` | 双击把 \\`RELEASE_NOTES.md\\` 复制进剪贴板，网页里 Ctrl+V 即可 |\n"
    "| \\`upload.cmd\\` | **全自动**：双击上传（Windows）。可重复运行，同名附件会先删再传 |"
)
assert old_row in s, 'readme row not found'
s = s.replace(old_row, new_rows, 1)

anchor = "fs.writeFileSync(path.join(target, 'upload.ps1'), uploadPs1.replace(/\\n/g, '\\r\\n'), 'utf8')"
assert anchor in s, 'anchor not found'

addition = anchor + """

// ── 最省事的两步：① 双击打开发布页 ② 双击把说明塞进剪贴板，再把包拖进网页 ──
var repoOwner = (pkg.repo && pkg.repo.owner) || ''
var repoName = (pkg.repo && pkg.repo.name) || ''
var releaseUrl =
  'https://github.com/' + repoOwner + '/' + repoName + '/releases/new?tag=v' + version +
  '&title=' + encodeURIComponent(version + ' · ' + pkg.name)
fs.writeFileSync(
  path.join(target, '1-打开发布页.url'),
  '[InternetShortcut]\\r\\nURL=' + releaseUrl + '\\r\\n',
  'utf8'
)

var copyNotesCmd = [
  '@echo off',
  'chcp 65001 >nul',
  'rem 把这一版的发布说明复制进剪贴板，网页里 Ctrl+V 粘贴到正文即可。',
  'clip < "%~dp0RELEASE_NOTES.md"',
  'if errorlevel 1 (',
  '  echo [失败] 没读到 RELEASE_NOTES.md',
  ') else (',
  '  echo [完成] 发布说明已复制到剪贴板，去网页里粘贴。',
  ')',
  'echo.',
  'pause >nul',
  ''
].join('\\n')
fs.writeFileSync(path.join(target, '2-复制发布说明.cmd'), copyNotesCmd.replace(/\\n/g, '\\r\\n'), 'utf8')"""

s = s.replace(anchor, addition, 1)
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('patched')
