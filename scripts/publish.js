/**
 * 一条命令发完一个版本：把 tag 推到 GitHub（commit 还没上去时）+ 建 Release + 传 .vnpkg。
 *
 *   node scripts/publish.js                       # 发当前 package.json 里的版本
 *   node scripts/publish.js --version=1.1.0       # 发指定版本（releases\v1.1.0\ 必须已经归档）
 *   node scripts/publish.js --dry-run             # 只看会做什么，不联网改任何东西
 *   node scripts/publish.js --no-push             # 不推 tag，只上传（tag 已在远端时用）
 *   node scripts/publish.js --main                # 额外把 main 也推上去（默认不推）
 *
 * 也可以直接双击 releases\v<版本号>\publish.cmd，或仓库根的 publish.cmd。
 * token 顺序：--token= → GITHUB_TOKEN → GH_TOKEN → .secrets/github-token
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const pkg = require(path.join(ROOT, 'package.json'))
const repoFull = `${pkg.repo?.owner}/${pkg.repo?.name}`

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const opt = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : ''
}

const version = opt('version') || pkg.version
const tag = `v${version}`
const dryRun = flag('dry-run')
const noPush = flag('no-push')
const alsoMain = flag('main')

const die = (message, hint) => {
  console.error(`\n✗ ${message}`)
  if (hint) console.error(`  ${hint}`)
  console.error('')
  process.exit(1)
}
const step = (message) => console.log(`  · ${message}`)

// ── token ────────────────────────────────────────────────────────────────
const tokenFile = path.join(ROOT, '.secrets', 'github-token')
const token =
  opt('token') ||
  process.env.GITHUB_TOKEN ||
  process.env.GH_TOKEN ||
  (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '')

// ── 产物必须已经归档 ──────────────────────────────────────────────────────
const dir = path.join(ROOT, 'releases', tag)
if (!fs.existsSync(dir)) {
  die(
    `没有 ${path.relative(ROOT, dir)} —— 这个版本还没归档`,
    `先跑一次：npm run release（会打包 + 归档 + 更新 CHANGELOG）`
  )
}
const metaFile = path.join(dir, 'meta.json')
const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : null
const vnpkg = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.vnpkg'))
  .map((f) => path.join(dir, f))[0]
if (!vnpkg) die(`${path.relative(ROOT, dir)} 里没有 .vnpkg`, '重新跑 npm run release')
if (meta && meta.version !== version) {
  die(`meta.json 记的是 ${meta.version}，这次要发 ${version}`, '目录名与包内版本不一致，重新 npm run release')
}

const relVnpkg = path.relative(ROOT, vnpkg)

// 以 tag 为准：meta.json 里的 gitCommit 只是「归档那一刻的 HEAD」，
// 归档之后还会有文档/脚本提交，HEAD 会往前走，但 tag 该指哪就指哪。
function tagCommit(ref) {
  const r = spawnSync('git', ['rev-parse', '--verify', `refs/tags/${ref}^{commit}`], {
    cwd: ROOT,
    encoding: 'utf8'
  })
  return r.status === 0 ? r.stdout.trim() : ''
}
const tagSha = tagCommit(tag)
const fullSha = tagSha || meta?.gitCommit || ''
if (tagSha && meta?.gitCommit && tagSha !== meta.gitCommit) {
  console.log(
    `  · 注意：meta.json 记的是 ${meta.gitCommit.slice(0, 7)}（归档时的 HEAD），tag ${tag} 指向 ${tagSha.slice(0, 7)}；按 tag 走`
  )
}

console.log(`\n${pkg.name} ${version} → ${repoFull}`)
console.log(`  附件    ${relVnpkg}  (${(fs.statSync(vnpkg).size / 1024).toFixed(2)} KB)`)
console.log(`  commit  ${fullSha ? fullSha.slice(0, 7) : '(meta.json 里没有记录)'}  (tag ${tag})`)

if (!token) {
  die(
    '没找到 token（--token= / GITHUB_TOKEN / GH_TOKEN / .secrets/github-token 都没有）',
    '双击仓库根的 set-token.cmd：复制 token → 双击 → 自动写入并验证'
  )
}
if (!fullSha) die('meta.json 缺 gitCommit，无法确定要发哪个 commit', '重新跑 npm run release')

// ── GitHub API ───────────────────────────────────────────────────────────
const GH = 'https://api.github.com'
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'character-atlas-publish'
}
const api = async (method, url, body) => {
  const res = await fetch(url.startsWith('http') ? url : GH + url, {
    method,
    headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, json, text }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function commitOnRemote() {
  const res = await api('GET', `/repos/${repoFull}/commits/${fullSha}`)
  return res.status === 200
}

async function pushRefs(refs, why) {
  const url = `https://x-access-token:${token}@github.com/${repoFull}.git`
  console.log(`\n· ${why}：git push ${refs.join(' ')}`)
  const out = spawnSync('git', ['-c', 'credential.helper=', 'push', url, ...refs], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
  })
  const scrub = (text) => String(text || '').split(token).join('***')
  const stdout = scrub(out.stdout)
  const stderr = scrub(out.stderr)
  if (stdout.trim()) console.log(stdout.trim())
  if (out.status !== 0) {
    console.error(stderr.trim() || '(no stderr)')
    die(
      'git push 失败',
      '常见原因：token 只有 Contents 权限（够用，但精细度不足时会报 403）、网络无法连通 github.com、或本地 tag 已被改过'
    )
  }
  if (stderr.trim()) console.log(stderr.trim())
}

;(async () => {
  // 1. commit 在不在远端？不在就推 tag
  const present = await commitOnRemote()
  if (present) {
    step(`commit ${fullSha.slice(0, 7)} 已在 GitHub 上`)
  } else if (noPush) {
    die(
      `commit ${fullSha.slice(0, 7)} 不在 GitHub 上`,
      '去掉 --no-push，或手动 git push origin ' + tag
    )
  } else if (dryRun) {
    step(
      tagSha
        ? `[dry-run] commit ${fullSha.slice(0, 7)} 不在 GitHub 上 → 会执行 git push ${tag}`
        : `[dry-run] 本地没有 tag ${tag}，正式跑会先提示你建 tag`
    )
  } else {
    if (!tagSha) die(`本地没有 tag ${tag}`, `git tag -a ${tag} -m "${version}" 后再跑`)
    await pushRefs([tag], `commit ${fullSha.slice(0, 7)} 还不在 GitHub 上，先推 tag`)
    let ok = false
    for (let i = 0; i < 10 && !ok; i++) {
      await sleep(2000)
      ok = await commitOnRemote()
    }
    if (!ok) die('推完 tag 之后 GitHub 仍然查不到这个 commit', '等几秒重跑；仍不行就去网页看 tag 是否真的存在')
    step(`已推到 GitHub，commit ${fullSha.slice(0, 7)} 可访问`)
  }

  if (alsoMain) {
    if (dryRun) step(`[dry-run] 会执行 git push main`)
    else await pushRefs(['main'], '同时把 main 分支也推上去')
  }

  // 1.5 源码快照：tag 这时肯定在本地了，把这一版的源码树打进 releases/v<ver>/
  if (!dryRun) {
    try {
      const { backupVersion } = require('./backup-source')
      const snap = backupVersion(version)
      if (snap.status === 'ok') step(`源码快照 ${path.basename(snap.zip)} (${(snap.bytes / 1024).toFixed(1)} KB)`)
      else step(`源码快照跳过：${snap.reason}`)
    } catch (error) {
      console.log(`  · 源码快照失败（不影响发布）：${error.message}`)
    }
  }

  // 2. Release + 附件：交给 upload-release.js（校验、幂等、回读都在那边）
  const uploadArgs = [path.join(ROOT, 'scripts', 'upload-release.js'), `--version=${version}`]
  if (dryRun) uploadArgs.push('--dry-run')
  console.log(`\n· node scripts/upload-release.js ${uploadArgs.slice(1).join(' ')}`)
  const run = spawnSync(process.execPath, uploadArgs, { cwd: ROOT, stdio: 'inherit' })
  if (run.status !== 0) process.exit(run.status || 1)
})().catch((error) => {
  die(`发布中断：${error && error.message ? error.message : String(error)}`)
})
