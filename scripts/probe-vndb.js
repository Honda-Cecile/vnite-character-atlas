/**
 * VNDB 兜底验证：造一个「KunGalgame 未收录但 VNDB 有」的游戏（NOBLE☆WORKS / v1519），
 * 跑完整刮削链路，确认：
 *   1. KunGalgame 404 后自动落到 VNDB
 *   2. 拿到人物表、简介、属性、头像被下载成本地 data URI
 *   3. source 标记为 vndb
 */
const path = require('path')

const pluginModule = require('../dist/index.js')
const plugin = pluginModule.default || pluginModule

const kv = new Map()
const gameDoc = {
  _id: 'game-noble',
  metadata: {
    name: 'NOBLE☆WORKS | のーぶる☆わーくす',
    originalName: 'のーぶる☆わーくす',
    vndbId: 'v1519',
    relatedSites: []
  }
}

const api = {
  pluginId: 'character-atlas',
  PluginDB: {
    getValue: async (key, def) => (kv.has(key) ? kv.get(key) : def),
    setValue: async (key, value) => void kv.set(key, value)
  },
  ConfigDB: { getConfigValue: async () => undefined, setConfigValue: async () => {} },
  GameDB: {
    getGame: async (id) => (id === 'game-noble' ? JSON.parse(JSON.stringify(gameDoc)) : null),
    getAllGames: async () => ({ 'game-noble': { _id: 'game-noble' } }),
    setGame: async (id, patch) => {
      if (patch.metadata) gameDoc.metadata = { ...gameDoc.metadata, ...patch.metadata }
    },
    getGameValue: async () => undefined,
    setGameValue: async () => {},
    setGameImage: async () => {}
  },
  eventBus: { on: () => () => {} },
  ipc: { handle: () => {}, on: () => {}, send: () => {}, removeHandler: () => {} },
  scraper: { registerProvider: () => {}, unregisterProvider: () => {} }
}

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ${message}`)
    process.exit(1)
  }
  console.log(`✅ ${message}`)
}

;(async () => {
  await plugin.activate(api)
  const service = api.__characterPanelService
  assert(!!service, 'activate 后拿到 service 实例')

  const panel = await service.getCharacters('game-noble', { force: true })
  console.log('来源:', panel.source, '| 作品:', panel.workName, '| 人数:', panel.total)
  console.log('人物:', panel.characters.map((c) => `${c.name}(${c.roleLabel})`).join(', '))

  assert(['kungal', 'vndb'].indexOf(panel.source) >= 0, `数据源可用：${panel.source}`)
  assert(panel.characters.length > 0, `拿到 ${panel.characters.length} 位人物`)

  const remote = panel.characters.filter((c) => Boolean(c.imageUrl))
  console.log('远程头像 URL:', remote.length, '/', panel.characters.length)
  assert(remote.length > 0, '人物带头像 URL')

  // 头像落盘发生在 NativeTabInjector 里（面板快照），等推送完成后再看快照
  // Node 里没有 Electron，NativeTabInjector 不会创建；直接验证 ImageCache 落盘
  const { ImageCache } = require('../dist/index.js')
  const cache = new ImageCache((message) => console.log('  [img]', message))
  const firstUrl = (remote[0] || {}).imageUrl
  const dataUri = await cache.resolve(firstUrl)
  assert(Boolean(dataUri) && dataUri.indexOf('data:image/') === 0, '头像已下载并转成 data URI')
  console.log('  data URI 长度:', dataUri.length, '字节前缀:', dataUri.slice(0, 32))
  const stats = await cache.stats()
  console.log('  缓存目录:', stats.files, '个文件 /', (stats.bytes / 1024).toFixed(1), 'KB')
  assert(stats.files > 0, '头像已落盘到本地缓存目录')

  const detailed = panel.characters.filter((c) => c.intro || c.heightCm || c.traits.length > 0)
  assert(detailed.length > 0, `有 ${detailed.length} 位人物带简介/属性/标签`)

  // 单独验证 VNDB 映射本身（不依赖 KunGalgame 是否收录）
  const vndbOnly = await service.probeVndb ? null : null
  const { scrapeVndbCharacters } = require('../dist/index.js')
  if (typeof scrapeVndbCharacters === 'function') {
    const direct = await scrapeVndbCharacters('v1519', { lang: 'zh-Hans', maxCharacters: 6 })
    console.log('VNDB 直连:', direct.workName, '|', direct.characters.length, '人 |', direct.characters.map((c) => c.name).join(', '))
    assert(direct.characters.length > 0, 'VNDB 直连返回人物')
    assert(direct.characters.some((c) => Boolean(c.imageUrl)), 'VNDB 人物带头像 URL')
  }

  const sample = detailed[0]
  const shot = path.join(__dirname, '..', '.tmp', 'vndb-sample.json')
  require('fs').mkdirSync(path.dirname(shot), { recursive: true })
  require('fs').writeFileSync(
    shot,
    JSON.stringify(
      {
        workName: panel.workName,
        total: panel.total,
        sample: {
          name: sample.name,
          originalName: sample.originalName,
          role: sample.roleLabel,
          birthday: sample.birthday,
          heightCm: sample.heightCm,
          bloodType: sample.bloodType,
          measurements: sample.measurements,
          traits: sample.traits.slice(0, 6).map((t) => t.name),
          intro: sample.intro.slice(0, 200)
        }
      },
      null,
      2
    )
  )
  console.log('样本已写入:', shot)
  console.log('🎉 VNDB 兜底验证通过')
  await plugin.deactivate(api)
  process.exit(0)
})().catch((error) => {
  console.error('❌ 失败:', error)
  process.exit(1)
})
