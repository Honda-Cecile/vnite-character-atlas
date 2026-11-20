/**
 * IPC 实参形状探针（离线，不联网）。
 *
 * 背景：Vnite 的 `api.ipc` 就是它自己的 IPCManager（`listener.handle` → `ipcMain.handle`），
 * 所以插件注册的 handler 收到的是 `(event, ...args)`。1.2.0 之前按 `(payload)` 写，
 * 结果 `payload.dataUrl` 全是 undefined，实机上表现为「出图失败：不是有效的图片数据」。
 *
 * 这个探针按 Vnite 真实调用约定（第一个参数是 IpcMainInvokeEvent）逐个打新频道：
 *   save-image / pick-image / set-image / stats
 * 并顺带验证「探针自己按 (payload) 直调」也还能用（向后兼容）。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

const TMP = path.join(os.tmpdir(), 'character-atlas-invoke')
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)
const picked = path.join(TMP, 'picked.png')
fs.writeFileSync(picked, PNG)
const savedPath = path.join(TMP, 'card.png')

// ---- 假 electron：只给插件真正用到的几块 ----
const fakeElectron = {
  app: {
    getPath: (name) => (name === 'exe' ? path.join(TMP, 'Vnite.exe') : path.join(TMP, 'userdata'))
  },
  dialog: {
    showSaveDialog: async () => ({ canceled: false, filePath: savedPath }),
    showOpenDialog: async () => ({ canceled: false, filePaths: [picked] })
  },
  nativeImage: {
    createFromBuffer: () => ({ isEmpty: () => true, resize: () => ({ toJPEG: () => PNG }) }),
    createFromPath: () => ({ isEmpty: () => true })
  },
  shell: { openPath: async () => '' }
}

process.versions.electron = '33.4.11'
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron
  return originalLoad.call(this, request, parent, isMain)
}

// 数据目录：让 ImageCache 认「安装版」分支 → <userData>/app/database
fs.mkdirSync(path.join(TMP, 'userdata', 'app', 'database'), { recursive: true })

const pluginModule = require('../dist/index.js')
const plugin = pluginModule.default || pluginModule

// ---- 内存版 Vnite API ----
const kv = new Map()
const ipcHandlers = {}
const api = {
  pluginId: 'character-atlas',
  PluginDB: {
    getValue: async (key, def) => (kv.has(key) ? kv.get(key) : def),
    setValue: async (key, value) => void kv.set(key, value)
  },
  ConfigDB: { getConfigValue: async () => undefined, setConfigValue: async () => {} },
  GameDB: {
    getGame: async () => null,
    getAllGames: async () => ({}),
    setGame: async () => {},
    getGameValue: async () => undefined,
    setGameValue: async () => {},
    setGameImage: async () => {}
  },
  eventBus: { on: () => () => {} },
  ipc: {
    handle: (channel, fn) => {
      ipcHandlers[channel] = fn
    },
    on: () => {},
    removeListener: () => {},
    send: () => {},
    removeHandler: (channel) => {
      delete ipcHandlers[channel]
    }
  },
  scraper: { registerProvider: () => {}, unregisterProvider: () => {} }
}

let failed = 0
function check(name, ok, extra) {
  if (!ok) failed += 1
  console.log((ok ? '✅ ' : '❌ ') + name + (extra === undefined ? '' : ' | ' + extra))
}

;(async () => {
  await plugin.activate(api)
  const channels = Object.keys(ipcHandlers).sort()
  console.log('已注册频道: ' + channels.length + ' → ' + channels.join(', '))

  // Vnite 真实调用约定：handler(event, payload)
  const event = { sender: { id: 1 }, frameId: 1, processId: 1, returnValue: undefined }

  // 1) stats：只要不抛错、能拿到结果对象即可（空库 → 0 部）
  const stats = await ipcHandlers['character-atlas:stats'](event)
  check('stats 认 (event) 形状', !!stats && stats.ok === true, JSON.stringify(stats).slice(0, 90))
  check('stats.games = 0', !!stats && stats.games === 0)
  check('stats.dir 指向缓存目录', !!stats && String(stats.dir).indexOf('character-atlas') >= 0, stats && stats.dir)

  // 2) pick-image
  const pickedRes = await ipcHandlers['character-atlas:pick-image'](event)
  check('pick-image 认 (event) 形状', !!pickedRes && pickedRes.ok === true && pickedRes.path === picked, JSON.stringify(pickedRes))

  // 3) set-image：复制进缓存目录 + 写修正层
  const setRes = await ipcHandlers['character-atlas:set-image'](event, {
    gameId: 'game-1',
    charId: 'c1',
    filePath: picked
  })
  check('set-image 拿到 payload（不再读 event）', !!setRes && setRes.ok === true, JSON.stringify(setRes))
  const storedPath = setRes && setRes.path ? String(setRes.path) : ''
  check('set-image 落盘到 images 目录', !!storedPath && fs.existsSync(storedPath), storedPath)
  check(
    '换图文件名形如 custom__<hash>.png',
    /custom__[0-9a-f]{16}\.png$/.test(storedPath),
    storedPath
  )
  const overrideDoc = kv.get('charpanel:v1:overrides:game-1')
  check(
    '修正层记下了 imageFile',
    !!overrideDoc && !!overrideDoc.edited && !!overrideDoc.edited.c1 && !!overrideDoc.edited.c1.imageFile,
    overrideDoc && JSON.stringify(overrideDoc.edited || {}).slice(0, 120)
  )

  // 4) save-image：dataURL → 文件
  const dataUrl = 'data:image/png;base64,' + PNG.toString('base64')
  const saveRes = await ipcHandlers['character-atlas:save-image'](event, {
    name: '本多 世枝瑠.png',
    dataUrl
  })
  check('save-image 拿到 payload（这就是出图报错的根因）', !!saveRes && saveRes.ok === true, JSON.stringify(saveRes))
  check('save-image 写出了 PNG', !!saveRes && fs.existsSync(String(saveRes.path)), saveRes && saveRes.path)
  const written = fs.existsSync(savedPath) ? fs.readFileSync(savedPath) : Buffer.alloc(0)
  check('写出的字节与 dataURL 一致', written.equals(PNG), written.length + ' B')

  // 5) 向后兼容：探针/旧渲染端按 (payload) 直调仍然能用
  const saveRes2 = await ipcHandlers['character-atlas:save-image']({ name: 'x.png', dataUrl })
  check('按 (payload) 直调仍然可用', !!saveRes2 && saveRes2.ok === true, JSON.stringify(saveRes2))

  // 6) 空载荷：给出「不是有效的图片数据」而不是崩
  const emptyRes = await ipcHandlers['character-atlas:save-image'](event)
  check('空载荷回落到明确报错', !!emptyRes && emptyRes.error === '不是有效的图片数据', JSON.stringify(emptyRes))

  await plugin.deactivate(api)

  console.log('')
  if (failed) {
    console.log('⚠️ 有 ' + failed + ' 项没通过')
    process.exit(1)
  }
  console.log('✅ IPC 实参形状（event + payload）全部通过')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
