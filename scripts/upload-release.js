/**
 * 一键发布一个版本到 GitHub Release（不需要 git push，也不需要装 gh）。
 *
 *   node scripts/upload-release.js                       # 发布 package.json 里的当前版本
 *   node scripts/upload-release.js --version=1.1.0       # 发布指定版本（产物得先在 releases/v1.1.0/）
 *   node scripts/upload-release.js --dry-run             # 只检查，不联网写任何东西
 *   node scripts/upload-release.js --token=ghp_xxx       # 临时给 token（推荐用 .secrets/github-token）
 *
 * 它做的事，按顺序：
 *   1. 读 releases/v<版本>/meta.json，校验安装包存在、大小与 sha256 对得上、包内 manifest 版本一致
 *   2. 确认这个版本的 commit 已经在 GitHub 上（用 meta.json 里的 gitCommit）
 *   3. tag v<版本> 不存在就按那个 commit 创建（**不会**让它指向主分支最新 commit）
 *   4. 建 Release（非 draft、非 prerelease），正文用同目录冻结的 RELEASE_NOTES.md
 *   5. 上传 .vnpkg；同名附件已存在就先删再传（可重复运行）
 *   6. 回读 Release，确认附件在、大小对得上，打印下载地址
 *
 * Token 来源（按顺序找）：--token= / GITHUB_TOKEN / GH_TOKEN / .secrets/github-token
 * 需要的权限：classic PAT 勾 repo；fine-grained PAT 勾 Contents: Read and write。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const RELEASES = path.join(ROOT, 'releases')
const API = 'https://api.github.com'
const UPLOADS = 'https://uploads.github.com'

const argv = process.argv.slice(2)
const argOf = (name) => {
  const hit = argv.find((arg) => arg.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3).trim() : ''
}
const dryRun = argv.includes('--dry-run')

const pkg = require(path.join(ROOT, 'package.json'))
const version = argOf('version') || String(pkg.version)
const repoFull = argOf('repo') || `${pkg.repo?.owner || ''}/${pkg.repo?.name || ''}`
const token = argOf('token') || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || readTokenFile()

function readTokenFile() {
  for (const rel of ['.secrets/github-token', 'releases/.github-token']) {
    const file = path.join(ROOT, rel)
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim()
  }
  return ''
}

function die(message, hint) {
  console.error(`\n✗ ${message}`)
  if (hint) console.error(`  ${hint}`)
  console.error('')
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

async function api(method, endpoint, body, base = API) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'character-atlas-release-script'
  }
  let payload
  if (body !== undefined) {
    if (Buffer.isBuffer(body)) {
      headers['Content-Type'] = 'application/octet-stream'
      payload = body
    } else {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }
  }
  const res = await fetch(base + endpoint, { method, headers, body: payload })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, json, text, headers: res.headers }
}

// ── 0. 参数与产物检查 ─────────────────────────────────────────────────────
if (!/^\d+\.\d+\.\d+$/.test(version)) die(`版本号格式不对：${version}`)
if (!/^[\w.-]+\/[\w.-]+$/.test(repoFull)) {
  die(`仓库地址不对：${repoFull || '(空)'}`, 'package.json 的 repo 字段应该是 {owner, name}')
}

const dir = path.join(RELEASES, `v${version}`)
const metaFile = path.join(dir, 'meta.json')
if (!fs.existsSync(dir) || !fs.existsSync(metaFile)) {
  die(`没有 releases/v${version}/`, `先归档：node scripts/stage-release.js --version=${version}`)
}
const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
const vnpkg = path.join(dir, meta.fileName)
const notesFile = path.join(dir, 'RELEASE_NOTES.md')

if (!fs.existsSync(vnpkg)) die(`缺安装包 ${meta.fileName}`, `重新归档：node scripts/stage-release.js --version=${version}`)

const bytes = fs.statSync(vnpkg).size
const digest = sha256(vnpkg)
if (bytes !== meta.bytes || digest !== meta.sha256) {
  die(
    '安装包与 meta.json 记录不一致（被换过？）',
    `meta 记录 ${meta.bytes} B / ${String(meta.sha256).slice(0, 12)}…，实际 ${bytes} B / ${digest.slice(0, 12)}…；重新归档后再传`
  )
}

// 附注 tag 的 rev-parse 返回的是 tag 对象，必须 ^{commit} 才能拿到真正的 commit
const fullSha = git(['rev-parse', `v${version}^{commit}`]) || git(['rev-parse', `${meta.gitCommit}^{commit}`]) || ''
if (!fullSha) die(`拿不到 v${version} 对应的 commit`, '本地既没有这个 tag，也没有 meta 记录的那个 commit')

const notes = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8').trim() : ''
if (!notes) console.log(`  · 没有 RELEASE_NOTES.md，Release 正文会留空`)

const title = `${version} · ${pkg.name}`

console.log(`\n${pkg.name} ${version} → ${repoFull}`)
console.log(`  附件    ${path.relative(ROOT, vnpkg)}  (${(bytes / 1024).toFixed(2)} KB)`)
console.log(`  sha256  ${digest}`)
console.log(`  commit  ${fullSha.slice(0, 7)}  (tag v${version})`)

if (!token) {
  console.log('\n· 没找到 token（--token= / GITHUB_TOKEN / GH_TOKEN / .secrets/github-token 都没有）')
  console.log(`  一次性配置：在仓库根建 .secrets/github-token，粘一个 PAT（权限 Contents: Read and write），这个目录已在 .gitignore 里`)
  if (!dryRun) {
    console.log('\n  这次只做了本地检查，没有联网。加 --dry-run 可以反复演练。\n')
    process.exit(2)
  }
}

if (dryRun) {
  console.log('\n[dry-run] 会依次执行：')
  console.log(`  GET  /repos/${repoFull}/commits/${fullSha.slice(0, 7)}            ← 确认 commit 已在 GitHub`)
  console.log(`  GET  /repos/${repoFull}/releases/tags/v${version}                 ← 看 Release 是否已存在`)
  console.log(`  POST /repos/${repoFull}/releases                              ← 不存在则创建（非 draft / 非 prerelease）`)
  console.log(`  POST ${UPLOADS}/repos/${repoFull}/releases/<id>/assets        ← 上传 ${meta.fileName}`)
  console.log('\n✓ dry-run 通过（本地检查全部正确）\n')
  process.exit(0)
}

// ── 1. commit 必须已经在远端 ──────────────────────────────────────────────
;(async () => {
  let check = await api('GET', `/repos/${repoFull}/commits/${fullSha}`)
  if (check.status === 404) {
    die(
      `GitHub 上找不到 commit ${fullSha.slice(0, 7)}`,
      `先把代码推上去：git push origin main（tag 会一起被推，或单独 git push origin v${version}）`
    )
  }
  if (check.status === 401) die('token 无效或已过期', '去 GitHub → Settings → Developer settings → Personal access tokens 重新生成')
  if (check.status === 403) die('token 权限不足（403）', 'classic PAT 需要 repo 权限；fine-grained 需要 Contents: Read and write')
  if (check.status !== 200) die(`查询 commit 失败：HTTP ${check.status}`, check.text.slice(0, 300))

  // ── 2. tag 必须指向那个 commit（不存在就按那个 commit 建，绝不指向主分支最新）──
  const ref = await api('GET', `/repos/${repoFull}/git/ref/tags/v${version}`)
  if (ref.status === 200) {
    let remoteSha = ref.json?.object?.sha || ''
    // 附注 tag（git tag -a）的 ref 指向的是 tag 对象，不是 commit，要再解一层
    if (ref.json?.object?.type === 'tag' && remoteSha) {
      const tagObj = await api('GET', `/repos/${repoFull}/git/tags/${remoteSha}`)
      if (tagObj.status === 200) remoteSha = tagObj.json?.object?.sha || remoteSha
    }
    if (remoteSha && remoteSha !== fullSha) {
      die(
        `远端 tag v${version} 指向 ${remoteSha.slice(0, 7)}，本地是 ${fullSha.slice(0, 7)}`,
        `先修 tag：git push origin :refs/tags/v${version} && git tag -d v${version} && git tag -a v${version} ${fullSha} && git push origin v${version}`
      )
    }
    console.log(`  · 远端 tag v${version} 已存在且指向正确`)
  } else if (ref.status === 404) {
    const created = await api('POST', `/repos/${repoFull}/git/refs`, {
      ref: `refs/tags/v${version}`,
      sha: fullSha
    })
    if (created.status !== 201) die(`创建 tag 失败：HTTP ${created.status}`, created.text.slice(0, 300))
    console.log(`  · 已创建 tag v${version} → ${fullSha.slice(0, 7)}`)
  } else {
    die(`查询 tag 失败：HTTP ${ref.status}`, ref.text.slice(0, 300))
  }

  // ── 3. Release：存在就复用并更新说明，不存在就建 ─────────────────────────
  let release = null
  const existing = await api('GET', `/repos/${repoFull}/releases/tags/v${version}`)
  if (existing.status === 200) {
    release = existing.json
    console.log(`  · Release v${version} 已存在（id ${release.id}，${release.assets?.length || 0} 个附件）`)
    if (release.draft || release.prerelease) {
      const patched = await api('PATCH', `/repos/${repoFull}/releases/${release.id}`, {
        draft: false,
        prerelease: false,
        body: notes || release.body
      })
      if (patched.status === 200) {
        release = patched.json
        console.log('  · 已取消 draft / prerelease（否则 Vnite 看不见）')
      }
    } else if (notes && release.body !== notes) {
      const patched = await api('PATCH', `/repos/${repoFull}/releases/${release.id}`, { body: notes })
      if (patched.status === 200) {
        release = patched.json
        console.log('  · 发布说明已按 RELEASE_NOTES.md 更新')
      }
    }
  } else if (existing.status === 404) {
    const created = await api('POST', `/repos/${repoFull}/releases`, {
      tag_name: `v${version}`,
      target_commitish: fullSha,
      name: title,
      body: notes,
      draft: false,
      prerelease: false
    })
    if (created.status !== 201) die(`创建 Release 失败：HTTP ${created.status}`, created.text.slice(0, 300))
    release = created.json
    console.log(`  · 已创建 Release v${version}（id ${release.id}）`)
  } else {
    die(`查询 Release 失败：HTTP ${existing.status}`, existing.text.slice(0, 300))
  }

  // ── 4. 附件：同名先删再传（保证可重复运行）──────────────────────────────
  const same = (release.assets || []).find((asset) => asset.name === meta.fileName)
  if (same) {
    const removed = await api('DELETE', `/repos/${repoFull}/releases/assets/${same.id}`)
    if (removed.status !== 204) die(`删除旧附件失败：HTTP ${removed.status}`, removed.text.slice(0, 300))
    console.log(`  · 已删除旧附件 ${same.name}（大小 ${(same.size / 1024).toFixed(2)} KB），准备重传`)
  }

  process.stdout.write(`  · 上传中 … `)
  const uploaded = await api(
    'POST',
    `/repos/${repoFull}/releases/${release.id}/assets?name=${encodeURIComponent(meta.fileName)}`,
    fs.readFileSync(vnpkg),
    UPLOADS
  )
  if (uploaded.status !== 201) die(`上传失败：HTTP ${uploaded.status}`, uploaded.text.slice(0, 300))
  console.log('完成')

  // ── 5. 回读确认 ──────────────────────────────────────────────────────────
  const after = await api('GET', `/repos/${repoFull}/releases/tags/v${version}`)
  const asset = (after.json?.assets || []).find((item) => item.name === meta.fileName)
  if (!asset) die('上传后回读不到附件，去网页确认一下')
  const okSize = asset.size === bytes
  const latest = await api('GET', `/repos/${repoFull}/releases/latest`)

  console.log('')
  console.log(`✓ Release v${version} 已就绪`)
  console.log(`  附件    ${asset.name}  ${(asset.size / 1024).toFixed(2)} KB${okSize ? '' : `  ⚠ 期望 ${(bytes / 1024).toFixed(2)} KB`}`)
  console.log(`  下载    ${asset.browser_download_url}`)
  console.log(`  页面    ${release.html_url}`)
  if (latest.status === 200 && latest.json?.tag_name !== `v${version}`) {
    console.log(`  · 注意：当前 latest 仍是 ${latest.json?.tag_name}（Vnite 的浏览页取 latest，装到这个版本需要等它变成最新，或直接用下载地址本地安装）`)
  } else if (latest.status === 200) {
    console.log('  · latest 就是这个版本，Vnite 浏览页会显示它')
  }
  console.log('')
})().catch((error) => {
  die(`脚本异常：${error && error.message ? error.message : String(error)}`)
})
