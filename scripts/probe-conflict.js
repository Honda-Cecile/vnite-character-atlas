/**
 * 复现并验证「409 Document update conflict」修复。
 *
 * 这个 mock 严格模仿 Vnite 4.15.0 的 BaseDBManager.getValue 语义：
 *   db.get(id) → not_found → 组新 doc → db.put(doc)
 * 并插入真实存在的 async 间隙，让并发读取真的撞上冲突。
 *
 * 预期：
 *   1) 直接 Promise.all 读 13 个 key → 抛 409 Document update conflict（就是用户看到的报错）
 *   2) plugin.activate(api) → 成功（ensurePluginDoc 先 upsert 建文档，再串行读）
 */
const path = require('path')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class ConflictDb {
  constructor() {
    this.doc = null
    this.getCalls = 0
    this.conflicts = 0
  }

  async getValue(key, defaultValue) {
    this.getCalls++
    await sleep(1)
    if (this.doc) {
      if (!(key in this.doc)) {
        // 文档存在但缺这个 key：Vnite 会走 setValue(upsert)，安全
        this.doc[key] = defaultValue
      }
      return this.doc[key]
    }
    await sleep(2) // 竞态窗口
    if (this.doc) {
      this.conflicts++
      const err = new Error('Failed to get plugin value: {"status":409,"name":"conflict","message":"Document update conflict"}')
      err.status = 409
      err.name = 'conflict'
      throw err
    }
    this.doc = { [key]: defaultValue }
    return defaultValue
  }

  async setValue(key, value) {
    await sleep(1)
    this.doc = { ...(this.doc ?? {}), [key]: value } // upsert：无则建、有则并
  }
}

function makeApi(db) {
  return {
    pluginId: 'character-atlas',
    PluginDB: db,
    ConfigDB: { getConfigValue: async () => undefined, setConfigValue: async () => {} },
    GameDB: {
      getGame: async () => null,
      setGame: async () => {},
      getAllGames: async () => ({})
    },
    eventBus: { on: () => () => {}, off: () => {}, emit: async () => {} },
    ipc: { handle: () => {}, removeHandler: () => {}, on: () => {}, send: () => {} },
    scraper: { registerProvider: () => {}, unregisterProvider: () => {} }
  }
}

async function main() {
  // ---------- 场景 1：裸并发读（复现线上报错） ----------
  const raw = new ConflictDb()
  const keys = ['apiKey', 'baseUrl', 'lang', 'nsfw', 'maxCharacters', 'autoOnLaunch', 'syncToMetadata', 'emitPanel', 'openPanelOnLaunch', 'cacheTtlHours', 'localRateLimit', 'nativeTab', 'nativeTabLabel']
  let rawError = null
  try {
    await Promise.all(keys.map((k) => raw.getValue(k, '')))
  } catch (error) {
    rawError = error
  }
  console.log('场景1 裸并发读 →', rawError ? '复现冲突: ' + rawError.message.slice(0, 90) : '没有复现（mock 时序问题）')

  // ---------- 场景 2：走插件 activate ----------
  const pluginModule = require(path.resolve(__dirname, '..', 'dist', 'index.js'))
  const plugin = pluginModule.default || pluginModule
  const db = new ConflictDb()
  const api = makeApi(db)
  let activateError = null
  try {
    await plugin.activate(api)
  } catch (error) {
    activateError = error
  }
  console.log('场景2 plugin.activate →', activateError ? '仍然失败: ' + activateError.message : '成功')
  console.log('  getValue 调用次数:', db.getCalls, '| 命中冲突次数:', db.conflicts, '| 文档 key 数:', Object.keys(db.doc ?? {}).length)

  await plugin.deactivate(api)

  // ---------- 场景 3：第二次激活（文档已存在，读路径不同） ----------
  const db2 = new ConflictDb()
  db2.doc = { apiKey: 'k', baseUrl: 'https://x/v2', lang: 'ja' }
  const api2 = makeApi(db2)
  let secondError = null
  try {
    await plugin.activate(api2)
  } catch (error) {
    secondError = error
  }
  console.log('场景3 二次激活（已有配置）→', secondError ? '失败: ' + secondError.message : '成功')
  await plugin.deactivate(api2)

  const ok = !activateError && !secondError && Boolean(rawError)
  console.log('\n结论:', ok ? '✅ 冲突已复现且修复有效' : '❌ 需要继续排查')
  process.exitCode = ok ? 0 : 1
}

main().catch((error) => {
  console.error('探针异常:', error)
  process.exitCode = 1
})
