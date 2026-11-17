/**
 * 离线验证「API Key 失效」这条链路（不联网，fake fetch）：
 *
 *   1. 请求层：带废 Key 请求 → 401 → 自动改用匿名重试，且之后不再带 Authorization；
 *   2. 服务层：内存里的 Key 是废的，刮削不再以「鉴权失败」结束；
 *   3. 设置页清空 Key 后（Vnite 只写库、不重载插件），下一次刮削直接走匿名，不再白撞一次 401。
 *
 *   node scripts/probe-auth.js
 */
const pluginModule = require('../dist/index.js')
const plugin = pluginModule.default || pluginModule
const { KungalClient } = pluginModule

const kv = new Map()
const gameDoc = {
  _id: 'game-1',
  metadata: { name: 'CLANNAD', originalName: 'クラナド', vndbId: 'v86', relatedSites: [] }
}

const api = {
  pluginId: 'character-atlas',
  PluginDB: {
    getValue: async (key, def) => (kv.has(key) ? kv.get(key) : def),
    setValue: async (key, value) => void kv.set(key, value)
  },
  ConfigDB: { getConfigValue: async () => undefined, setConfigValue: async () => {} },
  GameDB: {
    getGame: async (id) => (id === 'game-1' ? JSON.parse(JSON.stringify(gameDoc)) : null),
    getAllGames: async () => ({ 'game-1': { _id: 'game-1' } }),
    setGame: async () => {},
    getGameValue: async () => undefined,
    setGameValue: async () => {},
    setGameImage: async () => {}
  },
  eventBus: { on: () => () => {} },
  ipc: {
    handle: () => {},
    on: () => {},
    removeListener: () => {},
    removeHandler: () => {},
    send: () => {}
  },
  scraper: { registerProvider: () => {}, unregisterProvider: () => {} }
}

/** 只要请求带了 Authorization 就 401（复刻 NextMoe 对无效 Bearer 的响应），否则 404 */
const calls = []
const originalFetch = global.fetch
global.fetch = async (url, init = {}) => {
  const headers = init.headers || {}
  const auth = headers.Authorization || headers.authorization || null
  calls.push({ url: String(url), auth })
  if (auth) {
    return new Response(
      JSON.stringify({
        title: 'Invalid credential',
        status: 401,
        code: 'INVALID_CREDENTIAL',
        detail: 'Authorization Bearer token is invalid.'
      }),
      { status: 401, headers: { 'content-type': 'application/json' } }
    )
  }
  return new Response(JSON.stringify({ id: '86', title: 'CLANNAD', items: [], characters: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

let failures = 0
function check(condition, message, extra) {
  if (condition) {
    console.log(`✅ ${message}`)
    return
  }
  failures += 1
  console.error(`❌ ${message}${extra ? `（${extra}）` : ''}`)
}

;(async () => {
  // ── 1. 请求层：401 后自动降级匿名 ─────────────────────────────
  const fallbacks = []
  const client = new KungalClient({
    apiKey: 'nmk_invalid',
    baseUrl: 'https://api.nextmoe.dev/v2',
    nsfw: true,
    rateLimit: 60,
    onAuthFallback: (status, detail) => fallbacks.push({ status, detail })
  })
  const payload = await client.get('/catalog/works/86')
  check(Boolean(payload), '带无效 Key 的请求最终拿到响应（没有抛 AUTH_FAILED）')
  check(fallbacks.length === 1 && fallbacks[0].status === 401, '只回调一次降级提示，状态码 401', JSON.stringify(fallbacks))
  check(calls.length === 2 && Boolean(calls[0].auth) && !calls[1].auth, '第一次带 Authorization，重试时已去掉')

  calls.length = 0
  await client.get('/catalog/works/86')
  check(calls.length === 1 && !calls[0].auth, '之后的请求不再带 Authorization（省掉无效 401）')

  // ── 2/3. 服务层：清空 Key 后无需重启插件 ──────────────────────
  kv.set('apiKey', 'nmk_stale')
  await plugin.activate(api)
  const service = api.__characterPanelService
  check(Boolean(service), 'activate 成功')

  calls.length = 0
  let firstError = null
  try {
    await service.getCharacters('game-1', { force: true })
  } catch (error) {
    firstError = error
  }
  const text = firstError ? String(firstError.message || firstError) : ''
  check(!/鉴权失败|AUTH_FAILED/.test(text), '内存里是废 Key 时，刮削不再以「鉴权失败」结束', text)
  check(calls.some((c) => c.auth) && calls.some((c) => !c.auth), '第一次带旧 Key、随后自动改用匿名')

  // 模拟用户在设置页把 API Key 清空（Vnite 只写库，不会重载插件）
  kv.set('apiKey', '')
  calls.length = 0
  try {
    await service.getCharacters('game-1', { force: true })
  } catch {
    /* 404 是预期：faket fetch 只认 Authorization 这一维 */
  }
  check(calls.length > 0 && calls.every((c) => !c.auth), '清空 Key 后第一次请求就走匿名（重读了配置，不必重启）')

  await plugin.deactivate(api)
  global.fetch = originalFetch

  if (failures > 0) {
    console.error(`❌ ${failures} 项未通过`)
    process.exit(1)
  }
  console.log('✅ API Key 失效 / 清空 Key 两条链路都符合预期（401 自动降级 + 配置热重读）')
})().catch((error) => {
  global.fetch = originalFetch
  console.error('❌ probe-auth 崩溃:', error)
  process.exit(1)
})
