/**
 * 兼容性探针：验证图片缓存目录在「便携 / 安装」两种 Vnite 下的落点，以及全新机器
 * （数据库目录还不存在）能否自动创建。
 *
 * 判定规则对齐 Vnite 自己：便携 = `<exe 同目录>/app/database`，否则 `<userData>/app/database`。
 * 这里用 NODE_PATH 提供假 electron 模块伪造 app.getPath('exe'|'userData')，再拿
 * 编译产物 dist/index.js 里的 ImageCache 验证结果。
 *
 *   node scripts/probe-paths.js
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const root = path.join(os.tmpdir(), 'character-atlas-paths')
fs.rmSync(root, { recursive: true, force: true })
fs.mkdirSync(root, { recursive: true })

const exePath = path.join(root, 'vnite', 'Vnite.exe')
const userData = path.join(root, 'userdata')
fs.mkdirSync(path.dirname(exePath), { recursive: true })
fs.mkdirSync(userData, { recursive: true })
fs.writeFileSync(exePath, '')

const mockDir = path.join(root, 'mockmods', 'electron')
fs.mkdirSync(mockDir, { recursive: true })
fs.writeFileSync(
  path.join(mockDir, 'index.js'),
  `module.exports = {
    app: { getPath: (name) => (name === 'exe' ? ${JSON.stringify(exePath)} : ${JSON.stringify(userData)}) },
    nativeImage: null,
    shell: {},
    dialog: {}
  }`
)
process.env.NODE_PATH = path.join(root, 'mockmods')
require('module').Module._initPaths()

// 让 loadElectron() 认为自己在 electron 里跑
process.versions.electron = '35.0.0'

const { ImageCache } = require('../dist/index.js')

const appDir = path.join(root, 'vnite', 'app')
const dbDir = path.join(appDir, 'database')
const portableImages = path.join(dbDir, 'character-atlas', 'images')
const installedImages = path.join(userData, 'app', 'database', 'character-atlas', 'images')

let failed = 0
function check(name, actual, expect) {
  const ok = path.resolve(actual) === path.resolve(expect)
  if (!ok) failed += 1
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  console.log(`   ${actual}`)
  if (!ok) console.log(`   期望: ${expect}`)
}

const cases = [
  {
    name: '便携版 · exe 同目录已有 app/database/plugin（最可靠信号）',
    setup: () => {
      fs.mkdirSync(path.join(dbDir, 'plugin'), { recursive: true })
    },
    expect: portableImages
  },
  {
    name: '便携版 · 只有 app/database、还没有 plugin 库',
    setup: () => {
      fs.rmSync(dbDir, { recursive: true, force: true })
      fs.mkdirSync(dbDir, { recursive: true })
    },
    expect: portableImages
  },
  {
    name: '便携版 · 刚解压，app 目录在、database 还没建出来',
    setup: () => {
      fs.rmSync(dbDir, { recursive: true, force: true })
      fs.mkdirSync(appDir, { recursive: true })
    },
    expect: portableImages
  },
  {
    name: '安装版 · exe 旁边没有 app 目录 → %APPDATA%\\vnite',
    setup: () => {
      fs.rmSync(appDir, { recursive: true, force: true })
    },
    expect: installedImages
  }
]

;(async () => {
  for (const item of cases) {
    item.setup()
    const cache = new ImageCache(() => undefined)
    check(item.name, cache.dirSync(), item.expect)
  }

  // 全新机器：目录还不存在时，第一次用图片要能自己建出来
  fs.rmSync(path.join(userData, 'app'), { recursive: true, force: true })
  const fresh = new ImageCache(() => undefined)
  const stats = await fresh.stats()
  check('数据库目录不存在时自动递归创建', fresh.dirSync(), installedImages)
  console.log(`   条目 ${stats.files}`)

  const hint = path.dirname(fresh.dirSync())
  const hintOk = path.basename(hint) === 'character-atlas'
  if (!hintOk) failed += 1
  console.log(`${hintOk ? '✅' : '❌'} 导出对话框默认目录落在 character-atlas/ 下`)
  console.log(`   ${hint}`)

  // 判定理由（会写进 %TEMP%\character-atlas\debug.log）
  console.log(`\n判定理由示例: ${fresh.describeDir()}`)

  fs.rmSync(root, { recursive: true, force: true })
  console.log(failed ? `\n❌ ${failed} 项未通过` : '\n🎉 路径与便携判定全部通过')
  process.exit(failed ? 1 : 0)
})()
