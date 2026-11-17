/** 追踪真实请求路径：打印插件发出的每一次 HTTP 请求与状态 */
const path = require('path')
const fs = require('fs')

const log = []
const realFetch = global.fetch
global.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input)
  const res = await realFetch(input, init)
  let note = ''
  if (url.includes('/catalog/')) {
    try {
      const clone = res.clone()
      const body = await clone.json()
      if (body.items) note = `items=${body.items.length} ${body.items.map((i) => i.id + ':' + i.display_name).join(', ').slice(0, 200)}`
      else note = `id=${body.id} ${body.display_name ?? body.title ?? ''}`
    } catch {
      note = '<non-json>'
    }
  }
  log.push(`${res.status} ${url} ${note}`)
  return res
}

const pluginModule = require('../dist/index.js')
const plugin = pluginModule.default || pluginModule

const kv = new Map()
let ipcHandlers = {}
const api = {
  pluginId: 'character-atlas',
  PluginDB: { getValue: async (k, d) => (kv.has(k) ? kv.get(k) : d), setValue: async (k, v) => void kv.set(k, v) },
  ConfigDB: { getConfigValue: async () => undefined, setConfigValue: async () => {} },
  GameDB: {
    getGame: async () => ({
      _id: 'clannad',
      metadata: {
        name: 'CLANNAD | 克兰纳德',
        originalName: 'クラナド',
        vndbId: 'v86',
        relatedSites: [{ label: 'vndb', url: 'https://vndb.org/v86' }]
      }
    }),
    setGame: async () => {},
    getAllGames: async () => ({})
  },
  eventBus: { on: () => () => {}, off: () => {}, emit: async () => {} },
  ipc: { handle: (c, h) => void (ipcHandlers[c] = h), removeHandler: (c) => void delete ipcHandlers[c], on: () => {}, send: () => {} },
  scraper: { registerProvider: () => {}, unregisterProvider: () => {} }
}

async function main() {
  await plugin.activate(api)
  const panel = await ipcHandlers['character-atlas:get']({ gameId: 'clannad' })
  console.log('work:', panel.workId, panel.workName, '| characters:', panel.total)
  console.log('\n请求轨迹:')
  for (const line of log) console.log(' ', line)
  await plugin.deactivate(api)
}

main().catch((e) => {
  console.error('失败:', e)
  console.log('\n请求轨迹:')
  for (const line of log) console.log(' ', line)
  process.exitCode = 1
})
