/**
 * 同名重复条目合并验证（v0.8.7）。
 * 用户报「两部不同游戏显示同一份人物 / 同一份名单里同一个人两张卡」。
 * 实测 KunGalgame 的 work.characters 对同一角色有两条记录：
 *   26441 `姫野原 鈴蘭`（带罗马字/立绘） + 216890 `姫野原鈴蘭`（只有简体译名）
 * 本探针用真实 API 抓 886（三姉妹）与 1626（フルスロットル）两部作品，校验：
 *   1. 两个 gameId 解析到不同 workId；
 *   2. 每部作品内不再有归一化后同名的重复卡片，duplicates > 0；
 *   3. 被合并掉的写法进入保留者的 aliases；
 *   4. 两作人数不同（1626 多一个「夏美」），说明不是同一份名单串台。
 */
const pluginModule = require('../dist/index.js')
const plugin = pluginModule.default || pluginModule

const GAMES = {
  'game-886': {
    _id: 'game-886',
    metadata: { name: '女友×女友×女友  与三姐妹的精彩共同生活', originalName: '彼女×彼女×彼女～三姉妹とのドキドキ共同生活～' }
  },
  'game-1626': {
    _id: 'game-1626',
    metadata: { name: '女友×女友×女友　心跳 全油门！', originalName: '彼女×彼女×彼女　ドキドキ フルスロットル！' }
  }
}

const kv = new Map()
const ipcHandlers = {}
const ipcListeners = {}
const eventHandlers = {}

const clone = (value) => JSON.parse(JSON.stringify(value))

const api = {
  pluginId: 'character-atlas',
  PluginDB: {
    getValue: async (key, def) => (kv.has(key) ? kv.get(key) : def),
    setValue: async (key, value) => void kv.set(key, value)
  },
  ConfigDB: { getConfigValue: async () => undefined, setConfigValue: async () => {} },
  GameDB: {
    getGame: async (id) => (GAMES[id] ? clone(GAMES[id]) : null),
    getAllGames: async () => Object.fromEntries(Object.keys(GAMES).map((id) => [id, { _id: id }])),
    setGame: async () => {},
    getGameValue: async () => undefined,
    setGameValue: async () => {},
    setGameImage: async () => {}
  },
  eventBus: {
    on: (event, handler) => {
      eventHandlers[event] = handler
      return () => delete eventHandlers[event]
    }
  },
  ipc: {
    handle: (channel, fn) => {
      ipcHandlers[channel] = fn
    },
    on: (channel, fn) => {
      ipcListeners[channel] = fn
    },
    removeListener: (channel) => delete ipcListeners[channel],
    removeHandler: (channel) => delete ipcHandlers[channel],
    send: () => {}
  },
  scraper: { registerProvider: () => {}, unregisterProvider: () => {} }
}

function fail(message) {
  console.error(`❌ ${message}`)
  process.exit(1)
}

function assert(condition, message) {
  if (!condition) fail(message)
  console.log(`✅ ${message}`)
}

const key = (value) => String(value).replace(/[\s\u3000・·.,:;'"`|/\\-]/g, '').toLowerCase()

;(async () => {
  await plugin.activate(api)
  const service = api.__characterPanelService
  assert(Boolean(service), '服务实例可用')

  service.updateConfig({ ...service.config, maxCharacters: 20, localImages: false, vndbFallback: false })

  const results = {}
  for (const gameId of Object.keys(GAMES)) {
    const panel = await service.scrapeAndStore(gameId)
    results[gameId] = panel
    console.log(`\n— ${gameId} → workId=${panel.workId} ${panel.workName} 共 ${panel.total} 人（合并 ${panel.duplicates} 条）`)
    console.log('   名单:', panel.characters.map((c) => `${c.name}#${c.id}`).join(' / '))
  }

  const a = results['game-886']
  const b = results['game-1626']

  assert(a.source === 'kungal' && b.source === 'kungal', `数据源都是 KunGalgame（${a.source}/${b.source}）`)
  assert(a.workId === '886', `三姉妹解析到 #886（实际 #${a.workId}）`)
  assert(b.workId === '1626', `フルスロットル解析到 #1626（实际 #${b.workId}）`)
  assert(a.workId !== b.workId, '两部作品解析到不同 workId（不再共用一份缓存）')

  for (const [gameId, panel] of Object.entries(results)) {
    const keys = panel.characters.map((c) => key(c.name))
    const dupes = keys.filter((value, index) => keys.indexOf(value) !== index)
    assert(dupes.length === 0, `${gameId} 名单内没有同名重复卡片${dupes.length ? `（重复：${dupes.join(',')}）` : ''}`)
    assert(panel.duplicates > 0, `${gameId} 合并了同名条目（duplicates=${panel.duplicates}）`)
    assert(panel.total === panel.characters.length, `${gameId} total 与卡片数一致（${panel.total}）`)
  }

  const merged = a.characters.find((c) => c.id === '26441') || a.characters.find((c) => c.name.includes('鈴蘭'))
  assert(Boolean(merged), '三姉妹名单里保留了規範条目 姫野原 鈴蘭')
  assert(
    Boolean(merged) && merged.aliases.some((alias) => key(alias) === key(merged.name)),
    `合并掉的另一条写法进了别名（${merged ? merged.aliases.join(' / ') : ''}）`
  )

  assert(a.total !== b.total, `两作人数不同：三姉妹 ${a.total} 人 / 全油门 ${b.total} 人`)
  assert(b.characters.some((c) => c.name.includes('夏美') || c.id === '247576'), '全油门独有的「夏美」出现在它自己的名单里')
  assert(!a.characters.some((c) => c.id === '247576'), '三姉妹名单里没有全油门的独占角色 #247576')

  await plugin.deactivate?.(api)
  console.log('\n🎉 同名重复条目合并验证通过')
})().catch((error) => {
  console.error('❌ 探针异常:', error)
  process.exit(1)
})
