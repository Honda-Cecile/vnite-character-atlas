#!/usr/bin/env node
/**
 * 每个版本留一份**源码快照**。
 *
 *   releases/v1.1.0/source-v1.1.0.zip   ← git archive 出该 tag 的完整源码树
 *
 * 为什么要有它：`.vnpkg` 里只有编译后的 dist/index.js，看不出源码长什么样；
 * git 仓库又只有一个分支一直在往前跑。真出了事（远程仓库被删、tag 被误删、
 * 自己本地仓库损坏），手里得有「这一版到底是用哪些文件打出来的」。
 *
 * 用法：
 *   node scripts/backup-source.js                  # releases/ 下所有已有 tag 的版本
 *   node scripts/backup-source.js --version=1.1.0  # 只做这一版
 *   node scripts/backup-source.js --from=1.1.0     # 从这一版起（含）
 *   node scripts/backup-source.js --no-mirror      # 不写仓库外的备份目录
 *
 * 脚本会顺带把 sha256 补进 meta.json（sourceZip 字段）和 SHA256SUMS.txt，
 * 并镜像到仓库外 ../character-atlas-releases-backup/。
 *
 * 也可以被 require：`require('./backup-source').backupVersion('1.1.0')`
 * （publish.js 在推完 tag 后自动调它，保证发布过的版本一定有源码快照）。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const RELEASES = path.join(ROOT, 'releases')
const MIRROR_ROOT = path.resolve(ROOT, '..', `${path.basename(ROOT)}-releases-backup`)

function pkg() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function gitQuiet(args) {
  try {
    return git(args)
  } catch {
    return ''
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function tagCommit(version) {
  return gitQuiet(['rev-parse', '--verify', '-q', `refs/tags/v${version}^{commit}`])
}

function versionDirs() {
  if (!fs.existsSync(RELEASES)) return []
  return fs
    .readdirSync(RELEASES)
    .filter((name) => /^v\d+\.\d+\.\d+$/.test(name))
    .map((name) => name.slice(1))
    .sort(compareVersion)
}

function compareVersion(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

/** 重写 SHA256SUMS.txt：只保留 .vnpkg 与 source-*.zip 两类，按文件名排序。 */
function writeSums(dir) {
  const lines = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.vnpkg') || /^source-v\d+\.\d+\.\d+\.zip$/.test(name))
    .sort()
    .map((name) => {
      const file = path.join(dir, name)
      return `${sha256File(file)}  ${name}`
    })
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, 'utf8')
}

/**
 * 给一个版本补源码快照。
 * @returns {{ version: string, status: 'ok' | 'skip', reason?: string, zip?: string, bytes?: number, sha256?: string, commit?: string, mirror?: string }}
 */
function backupVersion(version, options = {}) {
  const mirror = options.mirror !== false
  const dir = path.join(RELEASES, `v${version}`)
  if (!fs.existsSync(dir)) return { version, status: 'skip', reason: `没有 releases/v${version}/ 目录` }

  const commit = tagCommit(version)
  if (!commit) return { version, status: 'skip', reason: `本地没有 tag v${version}（先打 tag 再跑）` }

  const id = pkg().id
  const name = `source-v${version}.zip`
  const out = path.join(dir, name)
  fs.rmSync(out, { force: true })
  execFileSync('git', ['archive', '--format=zip', `--prefix=${id}-${version}/`, '-o', out, `v${version}`], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const bytes = fs.statSync(out).size
  const sha256 = sha256File(out)

  const metaFile = path.join(dir, 'meta.json')
  if (fs.existsSync(metaFile)) {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
    meta.sourceZip = { name, bytes, sizeKB: Math.round((bytes / 1024) * 100) / 100, sha256, commit }
    fs.writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  }
  writeSums(dir)

  let mirrorPath = ''
  if (mirror) {
    const mirrorDir = path.join(MIRROR_ROOT, `v${version}`)
    fs.mkdirSync(mirrorDir, { recursive: true })
    fs.copyFileSync(out, path.join(mirrorDir, name))
    const mirrorMeta = path.join(mirrorDir, 'meta.json')
    if (fs.existsSync(metaFile)) fs.copyFileSync(metaFile, mirrorMeta)
    fs.copyFileSync(path.join(dir, 'SHA256SUMS.txt'), path.join(mirrorDir, 'SHA256SUMS.txt'))
    mirrorPath = path.join(mirrorDir, name)
  }

  return { version, status: 'ok', zip: out, bytes, sha256, commit, mirror: mirrorPath }
}

function backupAll(options = {}) {
  const only = options.version
  const from = options.from
  let versions = versionDirs()
  if (only) versions = versions.filter((v) => v === only)
  if (from) versions = versions.filter((v) => compareVersion(v, from) >= 0)
  return versions.map((v) => backupVersion(v, options))
}

function main() {
  const arg = (key) => {
    const hit = process.argv.find((a) => a.startsWith(`--${key}=`))
    return hit ? hit.slice(key.length + 3) : ''
  }
  const options = {
    version: arg('version'),
    from: arg('from'),
    mirror: !process.argv.includes('--no-mirror')
  }
  const results = backupAll(options)
  if (results.length === 0) {
    console.log('没有可备份的版本（releases/ 下没有 vX.Y.Z 目录）')
    return
  }
  for (const r of results) {
    if (r.status === 'skip') {
      console.log(`· v${r.version} 跳过：${r.reason}`)
      continue
    }
    console.log(
      `✓ v${r.version} 源码快照 ${path.basename(r.zip)}  ${(r.bytes / 1024).toFixed(1)} KB  ` +
        `commit ${r.commit.slice(0, 7)}  sha256 ${r.sha256.slice(0, 16)}…`
    )
    if (r.mirror) console.log(`  镜像 ${r.mirror}`)
  }
}

if (require.main === module) main()

module.exports = { backupVersion, backupAll, MIRROR_ROOT, RELEASES }
