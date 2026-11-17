/**
 * 回归：重复 activate / 重复 install 时不能触发 Electron 的
 *   Error: Attempted to register a second handler for 'character-atlas:get'
 *
 * 这里用一个「像 ipcMain 一样会抛错」的 mock：
 *   - handle(channel) 时若 channel 已存在 → 直接 throw
 *   - removeHandler(channel) 才会删掉
 * 覆盖三种现场：
 *   1. 同一实例 install() 两次
 *   2. 同一 api 上 activate() 两次（Vnite 热重载/重新启用）
 *   3. 上一个实例 activate 中途抛错留下的脏 handler（模拟 removeHandler 未被调用）
 */

const path = require('path')

const pluginModule = require('../dist/index.js')
const plugin = pluginModule.default || pluginModule

const kv = new Map()
const gameDoc = { _id: 'game-1', metadata: { name: 'CLANNAD', vndbId: '86', relatedSites: [] } }
const registered = new Map() // channel → handler，模拟 ipcMain 的真实状态
let handleCalls = 0

function makeIpc() {
  return {
    handle(channel, fn) {
      handleCalls += 1
      if (registered.has(channel)) {
        throw new Error(`Attempted to register a second handler for '${channel}'`)
      }
      registered.set(channel, fn)
    },
    removeHandler(channel) {
      registered.delete(channel)
    },
    on() {},
    send() {}
  }
}

const ipc = makeIpc()

const api = {
  pluginId: 'character-atlas',
  PluginDB: {
    getValue: async (key, def) => (kv.has(key) ? kv.get(key) : def),
    setValue: async (key, value) => void kv.set(key, value)
  },
  ConfigDB: { getConfigValue: async () => undefined, setConfigValue: async () => {} },
  GameDB: {
    getGame: async () => gameDoc,
    getAllGames: async () => ({ 'game-1': gameDoc }),
    setGame: async () => {},
    getGameValue: async () => undefined,
    setGameValue: async () => {},
    setGameImage: async () => {}
  },
  eventBus: { on: () => () => {}, emit: async () => {}, waitFor: async () => undefined },
  ipc,
  scraper: { registerProvider() {}, unregisterProvider() {} }
}

const results = []
function check(name, fn) {
  try {
    fn()
    results.push(['✅', name])
  } catch (error) {
    results.push(['❌', `${name} → ${error.message}`])
  }
}

;(async () => {
  // 场景 1：同一 api 连续 activate 两次（第一次正常，第二次走「上一个实例」分支）
  await plugin.activate(api)
  check('第 1 次 activate 注册 7 个 handler', () => {
    if (registered.size !== 7) throw new Error(`实际 ${registered.size}`)
  })

  const firstService = api.__characterPanelService
  await plugin.activate(api)
  check('第 2 次 activate 未抛 second handler', () => {
    if (registered.size !== 7) throw new Error(`实际 ${registered.size}`)
  })
  check('旧实例被替换', () => {
    if (api.__characterPanelService === firstService) throw new Error('仍是同一个实例')
  })

  // 场景 2：同一实例 install() 两次
  await plugin.activate(api)
  const service = api.__characterPanelService
  check('同一实例重复 install() 不抛错', () => {
    service.install()
    service.install()
    if (registered.size !== 7) throw new Error(`实际 ${registered.size}`)
  })

  // 场景 3：脏 handler —— 模拟上一个模块实例没走 deactivate 就消失了
  check('脏 handler 残留后仍能 activate', () => {
    registered.set('character-atlas:get', () => 'stale')
    const stale = new (pluginModule.CharacterPanelService)(api, service.config ?? {})
    stale.install()
    stale.uninstall()
    if (registered.size !== 0) throw new Error(`清理后仍有 ${registered.size} 个`)
  })

  await plugin.deactivate(api)
  check('deactivate 后 handler 清空', () => {
    if (registered.size !== 0) throw new Error(`实际 ${registered.size}`)
  })

  console.log('\n=== 重复注册回归 ===')
  for (const [mark, name] of results) console.log(`${mark} ${name}`)
  console.log(`ipc.handle 调用次数: ${handleCalls}`)
  const failed = results.filter(([mark]) => mark === '❌').length
  console.log(failed === 0 ? '\n结论: ✅ 幂等保护生效，不再出现 second handler' : `\n结论: ❌ ${failed} 项失败`)
  if (failed > 0) process.exit(1)
})().catch((error) => {
  console.error('❌ 探针异常:', error)
  process.exit(1)
})
