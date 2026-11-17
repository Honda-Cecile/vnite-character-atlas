/**
 * 主进程探针：个人修正层（删除 / 编辑）+ 新增游戏自动刮削的触发逻辑。
 *
 * 全程离线：直接往 mock PluginDB 里塞一份「已缓存的人物面板」，然后
 *   1. 走 character-atlas:get 拿数据
 *   2. 发 character-atlas:native-cmd remove-char → 断言人数减一、被删的 id 不再出现
 *   3. 发 edit-char → 断言名字 / 简介被改写
 *   4. 重新刮削（clear-cache + get）→ 断言删除依然生效（overrides 独立于缓存）
 *   5. reset-edits → 断言恢复原样
 *   6. game:added 事件：已有缓存的作品不重复发请求；没有缓存的作品会真的去刮（这里用
 *      autoOnLaunch=false 断言它被跳过）
 */
const pluginModule = require('../dist/index.js')
const plugin = pluginModule.default || pluginModule

const kv = new Map()
const ipcHandlers = {}
const ipcListeners = {}
const eventHandlers = {}
const logs = []

function panelOf(gameId, characters) {
  return {
    schemaVersion: 2,
    cachedAt: Date.now(),
    data: {
      schemaVersion: 2,
      gameId,
      workId: '886',
      workName: '测试作品',
      source: 'kungal',
      total: characters.length,
      enriched: characters.length,
      truncated: false,
      duplicates: 0,
      warnings: [],
      fetchedAt: Date.now(),
      characters
    }
  }
}

const CHARS = [
  { id: '26441', name: '姫野原 鈴蘭', originalName: 'Himenohara Suzuran', role: '主角', cv: '榊るな', facts: [], traits: [], aliases: [] },
  { id: '26440', name: '白檀 翠', role: '其他', cv: '吉川ナガレ', facts: [], traits: [], aliases: [] },
  { id: '81083', name: '志木 春臣', role: '主角', cv: '', facts: [], traits: [], aliases: [] }
]

const GAME = {
  _id: 'g-a',
  metadata: { name: '测试作品', originalName: 'テスト' }
}

const api = {
  pluginId: 'character-atlas',
  PluginDB: {
    getValue: async (key, def) => (kv.has(key) ? kv.get(key) : def),
    setValue: async (key, value) => void kv.set(key, value)
  },
  ConfigDB: {
    getConfigValue: async (key, def) => (key === 'autoOnLaunch' ? false : def),
    setConfigValue: async () => {}
  },
  GameDB: {
    getGame: async (id) => (id === 'g-a' ? GAME : null),
    setGame: async () => {},
    getAllGames: async () => ({ 'g-a': GAME })
  },
  eventBus: {
    on: (name, handler) => {
      eventHandlers[name] = handler
      return () => {
        delete eventHandlers[name]
      }
    },
    off: () => {},
    emit: async () => {}
  },
  ipc: {
    handle: (channel, handler) => {
      ipcHandlers[channel] = handler
    },
    removeHandler: (channel) => {
      delete ipcHandlers[channel]
    },
    on: (channel, handler) => {
      ipcListeners[channel] = handler
    },
    send: () => {}
  },
  scraper: { registerProvider: () => {}, unregisterProvider: () => {} }
}

const checks = []
function check(name, ok, extra) {
  checks.push({ name, ok })
  console.log((ok ? '✅ ' : '❌ ') + name + (extra ? ' | ' + extra : ''))
}

async function main() {
  kv.set('charpanel:v1:g-a', panelOf('g-a', CHARS.map((c) => ({ ...c }))))

  const realLog = console.log
  console.log = (...args) => {
    logs.push(args.join(' '))
    realLog(...args)
  }

  await plugin.activate(api)

  const get = () => ipcHandlers['character-atlas:get']({ gameId: 'g-a' })
  const sendCmd = (payload) => ipcListeners['character-atlas:native-cmd']({}, payload)

  let panel = await get()
  check('缓存读取', panel && panel.characters.length === 3, '人数=' + (panel && panel.characters.length))

  // 删除
  await sendCmd({ cmd: 'remove-char', gameId: 'g-a', id: '26441', name: '姫野原 鈴蘭' })
  await new Promise((r) => setTimeout(r, 60))
  panel = await get()
  check('删除后人数 3→2', panel.characters.length === 2, '人数=' + panel.characters.length)
  check('被删的 id 不再出现', panel.characters.every((c) => c.id !== '26441'))
  check('修正层写进了 PluginDB', !!(kv.get('charpanel:v1:overrides:g-a') || {}).removed)

  // 编辑
  await sendCmd({ cmd: 'edit-char', gameId: 'g-a', id: '26440', patch: { name: '白檀 翠（改）', intro: '手写的简介' } })
  await new Promise((r) => setTimeout(r, 60))
  panel = await get()
  const edited = panel.characters.find((c) => c.id === '26440')
  check('编辑后名字生效', edited && edited.name === '白檀 翠（改）', edited && edited.name)
  check('编辑后简介生效', edited && edited.intro === '手写的简介', edited && edited.intro)

  // 清缓存 + 重新取（模拟重新刮削失败后回落到缓存）：删除与编辑仍然生效
  kv.delete('charpanel:v1:g-a')
  await plugin.deactivate(api)
  await plugin.activate(api)
  kv.set('charpanel:v1:g-a', panelOf('g-a', CHARS.map((c) => ({ ...c }))))
  panel = await get()
  check('换新缓存后删除仍生效', panel.characters.length === 2, '人数=' + panel.characters.length)
  check('换新缓存后编辑仍生效', (panel.characters.find((c) => c.id === '26440') || {}).name === '白檀 翠（改）')

  // 复位
  await sendCmd({ cmd: 'reset-edits', gameId: 'g-a' })
  await new Promise((r) => setTimeout(r, 60))
  panel = await get()
  check('复位后恢复 3 人', panel.characters.length === 3, '人数=' + panel.characters.length)

  // 自动刮削：autoOnLaunch=false 时 game:added 不发请求
  const before = logs.filter((line) => line.includes('自动刮削')).length
  if (eventHandlers['game:added']) eventHandlers['game:added']({ data: { gameId: 'g-a' } })
  await new Promise((r) => setTimeout(r, 80))
  const after = logs.filter((line) => line.includes('自动刮削')).length
  check('autoOnLaunch=false 时新增游戏不刮', after === before, '刮削日志 ' + before + '→' + after)

  await plugin.deactivate(api)
  console.log = realLog

  const failed = checks.filter((c) => !c.ok).length
  console.log(failed === 0 ? '🎉 修正层 / 自动刮削探针全部通过' : '⚠️ 有 ' + failed + ' 项没通过')
  if (failed) process.exitCode = 1
}

main().catch((error) => {
  console.log('探针异常:', error)
  process.exitCode = 1
})
