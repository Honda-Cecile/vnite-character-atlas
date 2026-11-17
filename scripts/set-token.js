/**
 * 把剪贴板里的 GitHub token 存到 .secrets/github-token，并当场验证它能不能用。
 *
 *   node scripts/set-token.js            # 先复制 token，再跑这个（或双击根目录的 set-token.cmd）
 *
 * 只写本地文件，token 不会进仓库（.secrets/ 在 .gitignore 里）。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const pkg = require(path.join(ROOT, 'package.json'))
const repoFull = `${pkg.repo?.owner}/${pkg.repo?.name}`

function clipboard() {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], {
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .toString()
      .trim()
  } catch {
    return ''
  }
}

const look = (text) => `${text.slice(0, 4)}…${text.slice(-4)}（${text.length} 字符）`

const token = clipboard()
if (!token) {
  console.error('\n✗ 剪贴板是空的（或者读不到）。先把 token 复制下来，再运行一次。\n')
  process.exit(1)
}
if (!/^(ghp_|github_pat_|gho_|ghu_|ghs_)/.test(token) && token.length < 20) {
  console.error(`\n✗ 剪贴板里看起来不是 token：${look(token)}\n  GitHub 的 token 一般以 ghp_ 或 github_pat_ 开头。\n`)
  process.exit(1)
}

const dir = path.join(ROOT, '.secrets')
const file = path.join(dir, 'github-token')
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(file, `${token}\n`, 'utf8')
console.log(`\n· 已写入 ${path.relative(ROOT, file)}  ${look(token)}`)

;(async () => {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'character-atlas-set-token'
  }
  const res = await fetch(`https://api.github.com/repos/${repoFull}`, { headers })
  if (res.status === 401) {
    console.error('\n✗ token 无效或已过期。删掉 .secrets/github-token 后重新生成一个再试。\n')
    process.exit(1)
  }
  if (res.status === 404) {
    console.error(`\n✗ token 有效，但看不到仓库 ${repoFull}。fine-grained token 要把这个仓库加进仓库列表。\n`)
    process.exit(1)
  }
  if (res.status !== 200) {
    console.error(`\n✗ 查询仓库失败：HTTP ${res.status}\n`)
    process.exit(1)
  }
  const repo = await res.json()
  const perms = repo.permissions || {}
  const canWrite = perms.push === true || perms.maintain === true || perms.admin === true
  const who = await fetch('https://api.github.com/user', { headers })
  const me = who.status === 200 ? (await who.json()).login : '(未知)'

  console.log(`· 身份 ${me}，仓库 ${repo.full_name}（${repo.private ? '私有' : '公开'}）`)
  if (!canWrite) {
    console.error('\n✗ 这个 token 没有写权限，发不了 Release。classic 勾 repo；fine-grained 勾 Contents: Read and write。\n')
    process.exit(1)
  }
  console.log('\n✓ token 可用且有写权限。现在可以双击任意 releases\\v<版本号>\\ 里的 upload.cmd 了。\n')
})().catch((error) => {
  console.error(`\n✗ 联网检查失败：${error && error.message ? error.message : String(error)}\n`)
  process.exit(1)
})
