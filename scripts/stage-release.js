/**
 * 把一个版本的产物「归档」成一个自包含、互不覆盖的目录：
 *
 *   releases/v<版本号>/
 *     character-atlas-<版本号>.vnpkg   ← 安装包（Vnite 直接装这个）
 *     RELEASE_NOTES.md                 ← 冻结的发布说明（就是当时 GitHub Release 的正文）
 *     CHANGELOG.md                     ← 该版本的更新条目（从 docs/CHANGELOG.md 摘出来）
 *     meta.json                        ← 版本 / 日期 / git commit / 大小 / sha256
 *     SHA256SUMS.txt                   ← 校验用
 *
 * 同时刷新 releases/CHANGELOG.md（累积索引，新版本在上）与 releases/README.md，
 * 并把整份产物镜像到仓库外的备份目录，防止误删 / 重装系统后什么都没了。
 *
 *   node scripts/stage-release.js
 *   node scripts/stage-release.js --no-mirror     # 只写仓库内，不做外部镜像
 *
 * 只覆盖「同一个版本号」的目录；其它版本目录一律不动。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const RELEASES = path.join(ROOT, 'releases')
const DOCS = path.join(ROOT, 'docs')
const MIRROR_ROOT = path.resolve(ROOT, '..', 'character-atlas-releases-backup')

const pkg = require(path.join(ROOT, 'package.json'))

// 默认归档 package.json 里的当前版本；`--version=1.0.0` 可以补归档历史版本（需要 dist/ 里还留着那个包）
const versionArg = process.argv.find((arg) => arg.startsWith('--version='))
const version = versionArg ? versionArg.slice('--version='.length).trim() : String(pkg.version)
const vtag = `v${version}`
const mirror = !process.argv.includes('--no-mirror')
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`版本号格式不对：${version}`)

function fail(message) {
  console.error(`\n✗ ${message}\n`)
  process.exit(1)
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return ''
  }
}

/** 读 vnpkg 里的 manifest.json，确认包内版本与 package.json 一致（以免归档错包）。 */
function readPackedManifest(vnpkg) {
  const out = path.join(ROOT, '.tmp', 'stage-release')
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(out, { recursive: true })
  try {
    execFileSync('unzip', ['-o', '-q', vnpkg, 'manifest.json', '-d', out], { stdio: 'ignore' })
    return JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'))
  } catch {
    return null
  } finally {
    fs.rmSync(out, { recursive: true, force: true })
  }
}

/** 从 docs/CHANGELOG.md 里取出某个版本的整段（`## 1.1.0 · 2026-11-17` 到下一个 `## ` 之前）。 */
function changelogSection(version) {
  const file = path.join(DOCS, 'CHANGELOG.md')
  if (!fs.existsSync(file)) return ''
  const text = fs.readFileSync(file, 'utf8')
  const escaped = version.replace(/\./g, '\\.')
  const re = new RegExp(`^## ${escaped}\\b[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm')
  const hit = re.exec(text)
  return hit ? hit[0].trimEnd() : ''
}

/** releases/CHANGELOG.md：把所有版本目录里的 CHANGELOG.md 汇总成索引，新版本在上。 */
function rebuildIndex(entries) {
  const sorted = [...entries].sort((a, b) => {
    const pa = a.version.split('.').map(Number)
    const pb = b.version.split('.').map(Number)
    for (let i = 0; i < 3; i++) {
      if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) - (pa[i] || 0)
    }
    return 0
  })

  const head = [
    '# 各版本产物索引',
    '',
    '这个文件由 `node scripts/stage-release.js` 自动生成，不要手改。',
    '每个版本一个独立目录，互不覆盖；要发布哪个版本，就进对应目录拿 `.vnpkg` 和 `RELEASE_NOTES.md`。',
    '',
    '| 版本 | 打包日期 | 安装包 | 大小 | sha256 |',
    '| --- | --- | --- | --- | --- |'
  ]
  for (const item of sorted) {
    const rel = `./${item.dir}/${item.fileName}`
    head.push(
      `| [${item.version}](./${item.dir}/) | ${item.stagedAt.slice(0, 10)} | [${item.fileName}](${rel}) | ${item.sizeKB} KB | \`${item.sha256.slice(0, 12)}…\` |`
    )
  }
  head.push('')

  const body = sorted.map((item) => {
    const section = item.section || `## ${item.version}\n\n（该版本没有写更新条目）`
    return `${section}\n\n安装包：[\`${item.fileName}\`](./${item.dir}/${item.fileName}) · 打包日期 ${item.stagedAt.slice(0, 19).replace('T', ' ')} · ${item.sizeKB} KB\n`
  })

  fs.writeFileSync(path.join(RELEASES, 'CHANGELOG.md'), [head.join('\n'), ...body].join('\n'), 'utf8')
}

const README = `# releases —— 各版本产物（自动归档）

这个目录由 \`node scripts/stage-release.js\` 生成，**不要手动改里面的文件**，改源码后重新跑一遍即可。

每个版本一个目录，**互不覆盖、只增不删**：

\`\`\`
releases/
  CHANGELOG.md          ← 累积更新日志（新版本在上）+ 版本索引表
  README.md             ← 本文件
  v1.0.0/
    character-atlas-1.0.0.vnpkg
    RELEASE_NOTES.md    ← 冻结的发布说明（当时 GitHub Release 的正文）
    CHANGELOG.md        ← 该版本条目
    meta.json           ← 版本 / 日期 / git commit / 大小 / sha256
    SHA256SUMS.txt
  v1.1.0/
    ...
\`\`\`

## 发布某个版本

1. 进 \`releases/<版本号>/\`，把里面的 \`.vnpkg\` 上传到 GitHub Release 的附件。
2. Release 正文用同目录的 \`RELEASE_NOTES.md\`（已冻结，不会随源码变动）。
3. 标题写 \`<版本号>\`，tag 与目录名一致（例如 \`v1.1.0\`）。**别勾 Prerelease，别存成 Draft** —— Vnite 的浏览页只读非 draft / 非 prerelease 的最新 Release。

## 现在有哪些版本

见 [CHANGELOG.md](./CHANGELOG.md) 顶部的索引表。

## 备份

脚本会同时把同一份产物镜像到仓库外：\`../character-atlas-releases-backup/\`（默认路径，\`--no-mirror\` 可关）。

- 仓库内（\`releases/\`）已被 git 跟踪 → 推到 GitHub 就是异地备份。
- 仓库外镜像 → 覆盖「仓库目录被删 / 重装系统 / 换电脑」这种情况。
- 两份都是 \`.vnpkg\` 原文件，随时可以直接装。
`

// ── 1. 找到这个版本的安装包 ────────────────────────────────────────────────
const expected = path.join(DIST, `${pkg.id}-${version}.vnpkg`)
const candidates = fs.existsSync(DIST)
  ? fs.readdirSync(DIST).filter((name) => name.endsWith('.vnpkg') && name.includes(version))
  : []
if (!fs.existsSync(expected) && candidates.length === 0) {
  fail(
    `dist/ 里没有 ${pkg.id}-${version}.vnpkg。\n` +
      `  先打包：npm run pack\n` +
      `  现在 dist/ 里有：${fs.existsSync(DIST) ? fs.readdirSync(DIST).join(', ') || '（空）' : '（没有 dist 目录）'}`
  )
}
const vnpkg = fs.existsSync(expected) ? expected : path.join(DIST, candidates[0])
const fileName = path.basename(vnpkg)

// ── 2. 确认包内版本号对得上（防止把上一版归档成本版）──────────────────────
const packed = readPackedManifest(vnpkg)
if (packed && String(packed.version) !== version) {
  fail(`包内版本是 ${packed.version}，但 package.json 是 ${version}。先 npm run pack 重新打包。`)
}

// ── 3. 写版本目录 ─────────────────────────────────────────────────────────
const dirName = vtag
const target = path.join(RELEASES, dirName)
fs.mkdirSync(target, { recursive: true })

// 同版本重跑：先清掉本目录里的旧产物（只清本目录，绝不动别的版本）
for (const name of fs.readdirSync(target)) fs.rmSync(path.join(target, name), { recursive: true, force: true })

const stagedVnpkg = path.join(target, fileName)
fs.copyFileSync(vnpkg, stagedVnpkg)

const notesSrc = path.join(DOCS, 'RELEASE_NOTES.md')
if (version === String(pkg.version) && fs.existsSync(notesSrc)) {
  fs.copyFileSync(notesSrc, path.join(target, 'RELEASE_NOTES.md'))
} else {
  // 补归档历史版本：从该版本的 tag 里取当时那一份发布说明
  const historical = git(['show', `${vtag}:docs/RELEASE_NOTES.md`])
  if (historical) fs.writeFileSync(path.join(target, 'RELEASE_NOTES.md'), `${historical}\n`, 'utf8')
}

const section = changelogSection(version)
fs.writeFileSync(
  path.join(target, 'CHANGELOG.md'),
  [`# ${version}`, '', section ? section.replace(/^## [^\n]*\n/, '').trim() : '（该版本没有写更新条目）', ''].join('\n'),
  'utf8'
)

const digest = sha256(stagedVnpkg)
const bytes = fs.statSync(stagedVnpkg).size
const stagedAt = new Date().toISOString()

const meta = {
  id: pkg.id,
  name: pkg.name,
  version,
  tag: vtag,
  fileName,
  bytes,
  sizeKB: Number((bytes / 1024).toFixed(2)),
  sha256: digest,
  vniteVersion: pkg.vniteVersion,
  author: pkg.author,
  stagedAt,
  gitCommit: git(['rev-parse', '--short', 'HEAD']),
  gitTagExists: Boolean(git(['tag', '-l', vtag])),
  // 只看源码有没有未提交改动；releases/ 与 dist/ 是产物，归档动作本身不该把它标成 dirty
  gitDirty: Boolean(git(['status', '--porcelain', '--', '.', ':(exclude)releases', ':(exclude)dist', ':(exclude).tmp']))
}
fs.writeFileSync(path.join(target, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
fs.writeFileSync(path.join(target, 'SHA256SUMS.txt'), `${digest}  ${fileName}\n`, 'utf8')

// ── 3.5 每个版本目录里放一份「一键上传」脚本与说明，双击即可发布 ─────────────
const uploadCmd = `@echo off
chcp 65001 >nul
rem 双击这个文件，把 ${version} 发布到 GitHub Release。可以重复运行（同名附件会先删再传）。
cd /d "%~dp0..\\.."
node scripts\\upload-release.js --version=${version}
if errorlevel 1 (
  echo.
  echo [失败] 原因见上面几行。常见原因：没有 token、GitHub 上还没有这个 commit。
) else (
  echo.
  echo [完成] 去 GitHub 的 Releases 页面确认一下。
)
echo.
pause >nul
`

const uploadPs1 = `# 双击或用 PowerShell 运行：把 ${version} 发布到 GitHub Release。可重复运行。
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Resolve-Path (Join-Path $here '..\\..'))
node scripts/upload-release.js --version=${version}
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "[失败] 原因见上面几行。" -ForegroundColor Red
} else {
  Write-Host ""
  Write-Host "[完成] 去 GitHub 的 Releases 页面确认一下。" -ForegroundColor Green
}
Read-Host "按回车关闭" | Out-Null
`

const versionReadme = `# ${version}

这个目录是这个版本的全部产物，**不要手动改内容**，要改就改源码后重新 \`npm run release\`。

| 文件 | 用途 |
| --- | --- |
| \`${fileName}\` | 安装包。Vnite 里装的就是它；上传到 GitHub Release 的附件也是它 |
| \`RELEASE_NOTES.md\` | 冻结的发布说明（当时那份，不会随源码变化）。GitHub Release 正文用这份 |
| \`CHANGELOG.md\` | 这一版的更新条目 |
| \`meta.json\` | 版本 / 打包时间 / git commit / 大小 / sha256 |
| \`SHA256SUMS.txt\` | 校验和 |
| \`1-打开发布页.url\` | **最省事**：双击直接打开预填好 tag 与标题的 GitHub 新建 Release 页 |
| \`2-复制发布说明.cmd\` | 双击把 \`RELEASE_NOTES.md\` 复制进剪贴板，网页里 Ctrl+V 即可 |
| \`upload.cmd\` | **全自动**：双击上传（Windows）。可重复运行，同名附件会先删再传 |
| \`upload.ps1\` | 同上，PowerShell 版 |

## 一键上传

双击 \`upload.cmd\`。第一次用之前要做一次性的 token 配置：

1. GitHub → Settings → Developer settings → Personal access tokens
   - classic：勾 \`repo\`
   - fine-grained：勾 **Contents: Read and write**
2. 在仓库根建目录 \`.secrets\`，里面放一个纯文本文件 \`github-token\`，内容是 token（这个目录在 \`.gitignore\` 里，不会被提交）
3. 双击 \`upload.cmd\`

脚本会自己：确认 commit 已在 GitHub → tag 不存在就按这个版本的 commit 创建（**不会**指向主分支最新）→ 建 Release（非 draft / 非 prerelease）→ 上传附件 → 回读确认。想先演练就运行 \`node scripts/upload-release.js --version=${version} --dry-run\`。

## 手动上传（不想写 token）

GitHub → Releases → Draft a new release → **Choose a tag** 选已存在的 \`v${version}\`（**不要**新建 tag）→ 正文粘贴 \`RELEASE_NOTES.md\` → 附件选 \`${fileName}\` → 不要勾 prerelease、不要存 draft。
`

fs.writeFileSync(path.join(target, 'upload.cmd'), uploadCmd.replace(/\n/g, '\r\n'), 'utf8')
fs.writeFileSync(path.join(target, 'upload.ps1'), uploadPs1.replace(/\n/g, '\r\n'), 'utf8')

// ── 最省事的两步：① 双击打开发布页 ② 双击把说明塞进剪贴板，再把包拖进网页 ──
var repoOwner = (pkg.repo && pkg.repo.owner) || ''
var repoName = (pkg.repo && pkg.repo.name) || ''
var releaseUrl =
  'https://github.com/' + repoOwner + '/' + repoName + '/releases/new?tag=v' + version +
  '&title=' + encodeURIComponent(version + ' · ' + pkg.name)
fs.writeFileSync(
  path.join(target, '1-打开发布页.url'),
  '[InternetShortcut]\r\nURL=' + releaseUrl + '\r\n',
  'utf8'
)

var copyNotesCmd = [
  '@echo off',
  'chcp 65001 >nul',
  'rem 把这一版的发布说明复制进剪贴板，网页里 Ctrl+V 粘贴到正文即可。',
  "powershell -NoProfile -Command \"Get-Content -Raw -Encoding UTF8 '%~dp0RELEASE_NOTES.md' | Set-Clipboard\"",
  'if errorlevel 1 (',
  '  echo [失败] 没读到 RELEASE_NOTES.md',
  ') else (',
  '  echo [完成] 发布说明已复制到剪贴板，去网页里粘贴。',
  ')',
  'echo.',
  'pause >nul',
  ''
].join('\n')
fs.writeFileSync(path.join(target, '2-复制发布说明.cmd'), copyNotesCmd.replace(/\n/g, '\r\n'), 'utf8')
fs.writeFileSync(path.join(target, 'README.md'), versionReadme, 'utf8')


// ── 4. 刷新累积索引 ───────────────────────────────────────────────────────
const entries = fs
  .readdirSync(RELEASES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^v\d+\.\d+\.\d+$/.test(entry.name))
  .map((entry) => {
    const metaFile = path.join(RELEASES, entry.name, 'meta.json')
    if (!fs.existsSync(metaFile)) return null
    const data = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
    return { dir: entry.name, ...data, section: changelogSection(data.version) }
  })
  .filter(Boolean)

fs.mkdirSync(RELEASES, { recursive: true })
rebuildIndex(entries)
fs.writeFileSync(path.join(RELEASES, 'README.md'), README, 'utf8')

// ── 5. 仓库外镜像 ─────────────────────────────────────────────────────────
let mirrorLine = '已跳过外部镜像（--no-mirror）'
if (mirror) {
  const mirrorDir = path.join(MIRROR_ROOT, dirName)
  fs.mkdirSync(mirrorDir, { recursive: true })
  for (const name of fs.readdirSync(target)) {
    fs.copyFileSync(path.join(target, name), path.join(mirrorDir, name))
  }
  fs.copyFileSync(path.join(RELEASES, 'CHANGELOG.md'), path.join(MIRROR_ROOT, 'CHANGELOG.md'))
  fs.copyFileSync(path.join(RELEASES, 'README.md'), path.join(MIRROR_ROOT, 'README.md'))
  mirrorLine = `镜像到 ${mirrorDir}`
}

// ── 6. 汇报 ───────────────────────────────────────────────────────────────
console.log(`\n${pkg.name} ${version}`)
console.log(`  安装包   ${path.relative(ROOT, stagedVnpkg)}  (${meta.sizeKB} KB)`)
console.log(`  sha256   ${digest}`)
console.log(`  版本目录 ${path.relative(ROOT, target)}/  → ${fs.readdirSync(target).join(', ')}`)
console.log(`  累积索引 releases/CHANGELOG.md  （共 ${entries.length} 个版本：${entries.map((e) => e.version).sort().join(', ')}）`)
console.log(`  备份     ${mirrorLine}`)
if (meta.gitDirty) console.log('  ⚠ 工作区有未提交改动，产物的 gitCommit 只代表当时的 HEAD')
if (!meta.gitTagExists) console.log(`  ⚠ 本地还没有 tag ${vtag}，记得 git tag -a ${vtag}`)
console.log('')
