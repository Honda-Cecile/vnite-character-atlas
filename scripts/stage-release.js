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
    character-atlas-1.1.0.vnpkg
    source-v1.1.0.zip    ← 这一版的完整源码（git archive 出来的 tag 快照）
    meta.json            ← 版本 / 日期 / git commit / 大小 / 两个 sha256
    ...
\`\`\`

每个版本都带一份 **源码快照** \`source-v<版本>.zip\`：\`.vnpkg\` 里只有编译后的 \`dist/index.js\`，
真要看/重建这一版得靠源码。快照由 \`node scripts/backup-source.js\` 生成（\`npm run release\` 时若已有 tag
会自动带一份，\`publish.cmd\` 推完 tag 后也会补），\`npm run check:releases\` 会核对它的 sha256。

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

// ── 3.5 每个版本目录里放一份「一键发布」脚本：推 tag（需要时）+ 建 Release + 传包 ──
const publishCmd = `@echo off
chcp 65001 >nul
rem Publish ${version}: push tag if needed, then create/refresh the GitHub Release and upload the package.
rem Extra args are passed through: publish.cmd --dry-run / --no-push / --main
cd /d "%~dp0..\\.."
node scripts\\publish.js --version=${version} %*
if errorlevel 1 (
  echo.
  echo [FAILED] see the lines above.
) else (
  echo.
  echo [OK] check the Releases page on GitHub.
)
echo.
pause >nul
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
| \`source-v${version}.zip\` | 这一版的完整源码快照（\`git archive v${version}\`）；包里的 dist 只有编译结果，源码靠它留底 |
| \`publish.cmd\` | **双击发布**：commit 不在 GitHub 上就先推 tag，再建 Release、传包、回读确认 |

## 双击 publish.cmd

一步做完：确认 commit 在 GitHub（不在就 \`git push v${version}\`，**只推 tag，不动 main**）→ 校验包（大小 / sha256 / 包内版本）→ 建 Release（非 draft / 非 prerelease，正文取冻结的 \`RELEASE_NOTES.md\`）→ 上传附件（同名先删再传）→ 回读确认并打印下载地址。

可重复运行，不想要正式发布就先演练：

\`\`\`
publish.cmd --dry-run     只打印会做什么，不联网改任何东西
publish.cmd --no-push     不推 tag，只上传（tag 已在远端时用）
publish.cmd --main        顺手把 main 也推上去（默认不推）
\`\`\`

token 用一次就够了（仓库根的 \`set-token.cmd\` 会读剪贴板写入 \`.secrets/github-token\` 并验证写权限）。

## 手动发（不想用脚本）

GitHub → Releases → Draft a new release → **Choose a tag** 选已存在的 \`v${version}\`（**不要**新建 tag）→ 正文粘贴 \`RELEASE_NOTES.md\` → 附件选 \`${fileName}\` → 不要勾 prerelease、不要存 draft。
`

fs.writeFileSync(path.join(target, 'publish.cmd'), publishCmd.replace(/\n/g, '\r\n'), 'utf8')
fs.writeFileSync(path.join(target, 'README.md'), versionReadme, 'utf8')

// publish.cmd 只写 ASCII：cmd.exe 在 chcp 65001 之后按字节读文件，多字节内容会让行错位。
if (/[^\x00-\x7F]/.test(publishCmd)) {
  throw new Error('publish.cmd 里出现非 ASCII 字符，cmd 会解析错乱')
}
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

// ── 4.5 源码快照：把这个 tag 的源码树打进 source-v<版本>.zip ──────────────
// 新打的 tag 这时通常还不存在（tag 是发布那一步的事），跳过就行；
// publish.js 推完 tag 会再补一次，保证发布过的版本一定有源码快照。
var snapLine = '无（本地还没有这个 tag，发布时会补）'
try {
  var snap = require('./backup-source').backupVersion(version, { mirror: false })
  if (snap.status === 'ok') snapLine = `source-v${version}.zip (${(snap.bytes / 1024).toFixed(1)} KB)`
  else snapLine = '跳过：' + snap.reason
} catch (error) {
  snapLine = '失败：' + error.message
}

// ── 5. 仓库外镜像 ─────────────────────────────────────────────────────────
let mirrorLine = '已跳过外部镜像（--no-mirror）'
if (mirror) {
  const mirrorDir = path.join(MIRROR_ROOT, dirName)
  fs.mkdirSync(mirrorDir, { recursive: true })
  // 镜像要「同步」而不是「叠加」：先把镜像目录里这一版不该再有的文件删掉
  // （比如上一版生成过的 upload.cmd / upload.ps1），否则备份里会留着已经下线的脚本
  for (const stale of fs.readdirSync(mirrorDir)) {
    if (!fs.existsSync(path.join(target, stale))) fs.rmSync(path.join(mirrorDir, stale), { force: true })
  }
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
console.log(`  源码快照 ${snapLine}`)
console.log(`  备份     ${mirrorLine}`)
if (meta.gitDirty) console.log('  ⚠ 工作区有未提交改动，产物的 gitCommit 只代表当时的 HEAD')
if (!meta.gitTagExists) console.log(`  ⚠ 本地还没有 tag ${vtag}，记得 git tag -a ${vtag}`)
console.log('')
