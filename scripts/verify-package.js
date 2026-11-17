/**
 * 校验 .vnpkg：用 unzip 解到临时目录（bsdtar 解不了 archiver 产出的 zip），
 * 再读 manifest / require dist/index.js 检查导出与配置项。
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

const dir = path.resolve(__dirname, '..', 'dist')
const meta = require(path.resolve(__dirname, '..', 'package.json'))
const pkg = `${meta.id}-${meta.version}.vnpkg`
const out = path.join(os.tmpdir(), 'vncp-verify')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

execFileSync('unzip', ['-o', '-q', pkg, '-d', out], { cwd: dir, stdio: 'inherit' })

const walk = (root, prefix = '') =>
  fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    const abs = path.join(root, entry.name)
    return entry.isDirectory() ? walk(abs, rel) : [`${rel} — ${fs.statSync(abs).size} B`]
  })

console.log('包内文件:')
for (const line of walk(out)) console.log('  ', line)

const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'))
console.log('\nmanifest:')
console.log('  id/version:', manifest.id, manifest.version)
console.log('  category/main/vniteVersion:', manifest.category, manifest.main, manifest.vniteVersion)
console.log('  sdkVersion/packagedAt:', manifest.sdkVersion, manifest.packagedAt)
console.log('  配置项:', manifest.configuration.length, '→', manifest.configuration.map((c) => c.id).join(', '))

// Vnite 4.15.0 的 getConfigItemProps 会无条件下钻 config.controlOptions.controlType，
// 少一个字段就会把整个 /plugin 设置页打成「当前页面已停止渲染」
const badControls = manifest.configuration.filter(
  (item) => !item.controlOptions || typeof item.controlOptions.controlType !== 'string'
)
if (badControls.length) {
  console.error('  ✗ 缺少 controlOptions.controlType:', badControls.map((c) => c.id).join(', '))
  process.exitCode = 1
} else {
  console.log(
    '  controlType:',
    manifest.configuration.map((c) => `${c.id}=${c.controlOptions.controlType}`).join(', ')
  )
}

const mod = require(path.join(out, manifest.main))
console.log('\n导出:', Object.keys(mod).join(', '))
console.log('default.activate/deactivate:', typeof mod.default?.activate, '/', typeof mod.default?.deactivate)
console.log('BOOTSTRAP_SOURCE 字节:', Buffer.byteLength(mod.BOOTSTRAP_SOURCE ?? ''), '| NativeTabInjector:', typeof mod.NativeTabInjector)
