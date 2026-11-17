/**
 * 发布前一致性审计：确认「目录名 = 包内版本 = tag 里的 package.json 版本 = meta 记录」，
 * 免得出现「仓库已经 1.2.0、上传的附件却是 1.1.0、tag 又打在 1.2.0 上」这种串味。
 *
 *   node scripts/check-releases.js            # 审计全部版本
 *   node scripts/check-releases.js 1.1.0      # 只审计某个版本
 *
 * 全绿退出码 0；有问题退出码 1。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const RELEASES = path.join(ROOT, 'releases')
const only = process.argv[2] || ''

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return ''
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function packedVersion(vnpkg) {
  const out = path.join(ROOT, '.tmp', 'check-releases')
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(out, { recursive: true })
  try {
    execFileSync('unzip', ['-o', '-q', vnpkg, 'manifest.json', '-d', out], { stdio: 'ignore' })
    return JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')).version
  } catch {
    return ''
  } finally {
    fs.rmSync(out, { recursive: true, force: true })
  }
}

if (!fs.existsSync(RELEASES)) {
  console.error('✗ 没有 releases/ 目录，先跑 npm run release')
  process.exit(1)
}

const dirs = fs
  .readdirSync(RELEASES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^v\d+\.\d+\.\d+$/.test(entry.name))
  .map((entry) => entry.name)
  .filter((name) => !only || name === `v${only}`)
  .sort()

if (dirs.length === 0) {
  console.error(`✗ releases/ 里没有匹配的版本目录（筛选项：${only || '全部'}）`)
  process.exit(1)
}

const rows = []
let problems = 0
let warnings = 0

for (const dir of dirs) {
  const version = dir.slice(1)
  const target = path.join(RELEASES, dir)
  const metaFile = path.join(target, 'meta.json')
  const issues = []
  const notes = []

  // 1. meta.json 存在且版本对得上
  let meta = null
  if (!fs.existsSync(metaFile)) {
    issues.push('缺 meta.json')
  } else {
    meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
    if (String(meta.version) !== version) issues.push(`meta.version=${meta.version} 与目录名 ${version} 不一致`)
  }

  // 2. 安装包存在、大小与 sha256 与 meta 一致
  const fileName = meta?.fileName || `character-atlas-${version}.vnpkg`
  const vnpkg = path.join(target, fileName)
  if (!fs.existsSync(vnpkg)) {
    issues.push(`缺安装包 ${fileName}`)
  } else if (meta) {
    const bytes = fs.statSync(vnpkg).size
    if (bytes !== meta.bytes) issues.push(`大小 ${bytes} B ≠ meta.bytes ${meta.bytes} B`)
    if (sha256(vnpkg) !== meta.sha256) issues.push('sha256 与 meta 记录不一致（包被换过却没说）')
  }

  // 3. 包内 manifest 版本 == 目录名
  if (fs.existsSync(vnpkg)) {
    const inside = packedVersion(vnpkg)
    if (!inside) issues.push('读不出包内 manifest.json')
    else if (inside !== version) issues.push(`包内版本 ${inside} ≠ 目录名 ${version}（会把新包当旧版发出去）`)
  }

  // 4. tag 是否存在、tag 里的 package.json 是不是这个版本
  const tag = `v${version}`
  if (!git(['tag', '-l', tag])) {
    notes.push(`本地没有 tag ${tag}（发布前记得 git tag -a ${tag}）`)
    warnings++
  } else {
    const tagPkgRaw = git(['show', `${tag}:package.json`])
    if (!tagPkgRaw) {
      issues.push(`tag ${tag} 里读不到 package.json`)
    } else {
      try {
        const tagVersion = JSON.parse(tagPkgRaw).version
        if (String(tagVersion) !== version) {
          issues.push(`tag ${tag} 指向的 commit 里 package.json 是 ${tagVersion}，不是 ${version}（tag 打错地方了）`)
        }
      } catch {
        issues.push(`tag ${tag} 的 package.json 解析失败`)
      }
    }
  }

  // 5. 包内 vniteVersion 是否与 package.json 一致（Vnite 用主分支的这份做兼容判断）
  const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  if (meta && String(meta.version) === String(current.version) && fs.existsSync(vnpkg)) {
    const inside = packedVersion(vnpkg)
    if (inside !== String(current.version)) issues.push(`当前 package.json 是 ${current.version}，但包里是 ${inside}`)
  }

  problems += issues.length
  rows.push({ version, issues, notes })
}

// ── 输出 ──────────────────────────────────────────────────────────────────
const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
console.log(`\nreleases/ 审计（当前源码版本 ${current.version}，HEAD ${git(['rev-parse', '--short', 'HEAD']) || '?'}）\n`)

for (const row of rows) {
  const bad = row.issues.length > 0
  console.log(`${bad ? '✗' : '✓'} v${row.version}`)
  for (const line of row.issues) console.log(`    ✗ ${line}`)
  for (const line of row.notes) console.log(`    · ${line}`)
  if (!bad && row.notes.length === 0) console.log('    目录 / 包内版本 / tag / 校验和 全部一致')
}

const staged = rows.map((row) => row.version)
const ahead = staged.filter((v) => v !== String(current.version))
if (ahead.length > 0) {
  console.log(
    `\n提示：releases/ 里有 ${ahead.map((v) => `v${v}`).join('、')} 与当前源码 ${current.version} 不同，` +
      `这是正常的「产物先归档、发布后补」。发布时务必：`
  )
  console.log('  1) Release 一定选「Choose a tag」里已存在的旧 tag，别用「新建 tag」（默认会打在 main 的最新 commit 上）；')
  console.log('  2) 附件从对应 releases/v<版本号>/ 里拿，别从 dist/ 拿（dist/ 里躺着的是最新版）。')
}

console.log('')
if (problems > 0) {
  console.log(`✗ 共 ${problems} 处问题需要修\n`)
  process.exit(1)
}
console.log(`✓ 全部通过${warnings ? `（${warnings} 条提醒）` : ''}\n`)
