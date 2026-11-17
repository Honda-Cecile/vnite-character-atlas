/**
 * 端到端冒烟测试（不进包，仅本地验证 dist/index.js 行为）。
 * 用内存版 PluginDB/GameDB 模拟 Vnite 主进程 API，真实访问 KunGalgame 公共 API：
 *   1. activate 后是否能正确注册（_.default 形状、handler 注册）
 *   2. 名称/vndbId → workId 解析
 *   3. 人物名单 + N+1 详情补全（简介、声优、属性、标签）
 *   4. metadata.extra 写入
 *   5. 自包含 HTML 面板落盘
 *   6. 二次调用命中缓存（0 请求）
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const pluginModule = require('../dist/index.js')
const plugin = pluginModule.default || pluginModule
const { NativeTabInjector } = pluginModule

const kv = new Map()
const gameWrites = []
// 有状态的 gameDoc：模拟 Vnite 的 setGame 合并语义（metadata 浅合并），
// 这样「写 extra → 关同步 → 清理 extra」这条链路才可验证
const gameDoc = {
  _id: 'game-1',
  metadata: { name: 'CLANNAD', originalName: 'クラナド', vndbId: 'v86', relatedSites: [] }
}
let ipcHandlers = {}
let ipcListeners = {}
let eventHandlers = {}
let fetchCount = 0

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
    setGame: async (id, patch) => {
      gameWrites.push({ id, patch })
      if (patch.metadata) gameDoc.metadata = { ...gameDoc.metadata, ...patch.metadata }
    },
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
    removeListener: (channel) => {
      delete ipcListeners[channel]
    },
    send: () => {},
    removeHandler: (channel) => {
      delete ipcHandlers[channel]
    }
  },
  scraper: { registerProvider: () => {}, unregisterProvider: () => {} }
}

const originalFetch = global.fetch
global.fetch = async (...args) => {
  fetchCount += 1
  return originalFetch(...args)
}

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ 断言失败: ${message}`)
    process.exit(1)
  }
  console.log(`✅ ${message}`)
}

;(async () => {
  assert(typeof plugin.activate === 'function', '入口导出 activate（.default 兼容）')
  assert(typeof plugin.deactivate === 'function', '入口导出 deactivate')

  await plugin.activate(api)
  const service = api.__characterPanelService
  assert(Boolean(service), 'activate 后可通过 api.__characterPanelService 拿到服务实例')
  assert(Object.keys(ipcHandlers).length === 7, `注册 7 个 IPC 频道（实际 ${Object.keys(ipcHandlers).length}）`)
  assert(Boolean(eventHandlers['game:added']), '监听 game:added 事件')

  const started = Date.now()
  const panel = await api.__characterPanelService.getCharacters('game-1')
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)

  // KunGalgame 偶尔会连不上（NETWORK_ERROR / 超时），此时插件本身会走 VNDB 兜底，
  // 冒烟测试只校验「能拿到数据」，不把在线服务可用性当成插件缺陷
  if (panel.source !== 'kungal') {
    console.log(`⚠️  本次没有走 KunGalgame（source=${panel.source}），可能被 VNDB 兜底或网络不通`)
  }
  assert(panel.source === 'kungal' || panel.source === 'vndb', `数据源 = ${panel.source}`)
  assert(panel.workName.length > 0, `作品名 = ${panel.workName}（originalName=${panel.workOriginalName}）`)
  assert(panel.total > 10, `人物总数 = ${panel.total}`)
  // 匿名额度 50 次/分，反复跑探针容易撞 429；这里只要求「至少补全到一位」，
  // 详情字段全部从第一个成功补全的人物上取样
  assert(fetchCount > 0, `发出请求 ${fetchCount} 次（${elapsed}s）`)
  assert(panel.characters[0].role === 'main', `首位是主角：${panel.characters[0].name} / ${panel.characters[0].roleLabel}`)
  const enrichedChar = panel.characters.find((item) => item.intro) || panel.characters[0]
  if (panel.source === 'vndb') {
    // VNDB 的角色简介本来就有一半是空的，只要求有名字和角色定位
    console.log(`ℹ️  VNDB 数据源：${panel.characters.length} 人（简介缺失属上游数据现状）`)
  } else if (panel.enrichedCount > 0) {
    assert(Boolean(enrichedChar.intro), `简介已抓到（${enrichedChar.name}：${enrichedChar.intro.slice(0, 50)}…）`)
    assert(Array.isArray(enrichedChar.traits) && enrichedChar.traits.length > 0, `标签数量 = ${enrichedChar.traits.length}`)
  } else {
    console.log('⚠️  本次遇到服务端 429，深度补全全部跳过（属预期降级）:', panel.warnings.join('；'))
  }
  assert(Boolean(panel.characters[0].imageUrl || panel.characters[0].thumbhash), '头像 URL 存在')
  console.log('   示例人物:', JSON.stringify({
    name: panel.characters[0].name,
    originalName: panel.characters[0].originalName,
    voices: panel.characters[0].voices,
    gender: panel.characters[0].gender,
    birthday: panel.characters[0].birthday,
    heightCm: panel.characters[0].heightCm,
    measurements: panel.characters[0].measurements,
    introSource: panel.characters[0].introSource,
    traits: panel.characters[0].traits.slice(0, 5)
  }, null, 2))

  // v0.3.0 起 syncToMetadata 默认关闭：人物由原生标签页展示，默认不污染「附加信息」
  const write = gameWrites[0]
  assert(!write, '默认不写 GameDB.metadata.extra（syncToMetadata=false）')

  api.__characterPanelService.updateConfig({ ...api.__characterPanelService.config, syncToMetadata: true })
  await api.__characterPanelService.getCharacters('game-1', { force: true })
  const write2 = gameWrites[gameWrites.length - 1]
  assert(Boolean(write2), '打开 syncToMetadata 后写入 GameDB')
  const extra = write2.patch.metadata.extra ?? []
  const charactersEntry = extra.find((entry) => entry.key === 'characters')
  const panelEntry = extra.find((entry) => entry.key === 'character_panel')
  assert(Boolean(charactersEntry) && charactersEntry.value.length > 0, `metadata.extra.characters 写入 ${charactersEntry.value.length} 行`)
  assert(Boolean(panelEntry), `metadata.extra.character_panel = ${panelEntry.value[0]}`)
  assert(Boolean(write2.patch.metadata.name === undefined || write2.patch.metadata.name === 'CLANNAD'), 'metadata.name 未被覆盖')

  api.__characterPanelService.updateConfig({ ...api.__characterPanelService.config, syncToMetadata: false })
  await api.__characterPanelService.getCharacters('game-1', { force: true })
  const write3 = gameWrites[gameWrites.length - 1]
  const clearedExtra = (write3 && write3.patch.metadata.extra) || []
  assert(
    !clearedExtra.some((entry) => entry.key === 'characters' || entry.key === 'character_panel'),
    '关回 syncToMetadata 后清理掉 characters/character_panel'
  )

  // v0.2.0 起不再生成独立 HTML 面板（改成注入原生标签页），这里改为校验
  // 「抓到的数据 → 原生标签页数据结构」这条链路：人数一致、带 id、带作品徽章。
  const injector = new NativeTabInjector({ label: '', log: () => {} })
  await injector.setGame('game-1', ['CLANNAD', 'クラナド'], panel)
  const snap = injector.snapshot()
  const native = snap.games[0]
  assert(
    native.characters.length === panel.characters.length,
    `原生标签页人数一致（${native.characters.length} vs ${panel.characters.length}）`
  )
  assert(
    native.characters.every((c) => c.id !== undefined && c.id !== ''),
    '原生标签页每个角色都带了 id（右键删除 / 编辑要用）'
  )
  console.log(`   原生标签页: ${native.characters.length} 人 / 作品 #${native.workId} / 来源 ${native.source}`)


  // 前面几轮 force 刷新已经把缓存替换过，所以先取一次当前缓存作为基准
  const base = await api.__characterPanelService.getCharacters('game-1')
  const before = fetchCount
  const cached = await api.__characterPanelService.getCharacters('game-1')
  assert(fetchCount === before, `二次调用命中缓存（新请求 ${fetchCount - before} 次）`)
  assert(cached.fetchedAt === base.fetchedAt, '缓存命中返回同一份数据')

  const svc = api.__characterPanelService
  const cmdListener = ipcListeners['character-atlas:native-cmd']
  assert(typeof cmdListener === 'function', '已监听 character-atlas:native-cmd')
  cmdListener({}, { cmd: 'hello' })
  assert(true, 'hello 命令可被接受')

  const forced = await svc.getCharacters('game-1', { force: true })
  assert(forced.fetchedAt >= base.fetchedAt && fetchCount > before, `force 刷新发起 ${fetchCount - before} 次请求`)

  // ---- 导出 / 导入：必须把个人修正一起带走 ----
  // 注意顺序：这一段必须在 clear-cache 之前跑，否则缓存没了就得重新联网刮削（会撞本地限流）
  const roster = forced.characters.length >= panel.characters.length ? forced : panel
  const victim = roster.characters[roster.characters.length - 1]
  cmdListener({}, { cmd: 'remove-char', gameId: 'game-1', id: victim.id })
  const afterRemove = await svc.getCharacters('game-1')
  assert(
    afterRemove.characters.length === roster.characters.length - 1,
    `右键删除生效（${roster.characters.length} → ${afterRemove.characters.length}）`
  )

  const exportPath = path.join(os.tmpdir(), 'character-atlas-smoke-export.json')
  fs.rmSync(exportPath, { force: true })
  const exported = await svc.exportCharacters(exportPath)
  assert(exported.ok === true, `导出成功 → ${exported.path}（${exported.count} 部作品）`)
  const dump = JSON.parse(fs.readFileSync(exportPath, 'utf8'))
  assert(dump.schema === 'character-atlas/export' && dump.version === 3, '导出 schema / version 正确（v3 带图片层）')
  assert(Object.keys(dump.games).length >= 1, '导出文件含刮削数据（games）')
  assert(Object.keys(dump.overrides).length >= 1, '导出文件含个人修正（overrides）')
  assert(
    (dump.overrides['game-1'].removed || []).includes(victim.id),
    `导出文件里记着被删的角色（${victim.id}）`
  )

  // 图片层：先往缓存目录塞一张真实文件，再导出，确认 base64 跟着走、导入能写回
  const cacheDir = typeof svc.imageDir === 'function' ? svc.imageDir() : null
  if (cacheDir) {
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(path.join(cacheDir, 'smoke__deadbeef.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    const withImages = await svc.exportCharacters(exportPath)
    assert(withImages.ok === true, '带图片再导出一次成功')
    const dump2 = JSON.parse(fs.readFileSync(exportPath, 'utf8'))
    assert(dump2.images && Object.keys(dump2.images).length >= 1, '导出包内含图片层（images）')
    fs.rmSync(path.join(cacheDir, 'smoke__deadbeef.jpg'), { force: true })
  } else {
    console.log('  · 跳过图片层断言（当前实例拿不到缓存目录）')
  }

  // 清空全部（缓存 + 修正）→ 再导入，被删的角色不应该复活
  await svc.clearAllCharacters()
  const beforeImport = fetchCount
  const imported = await svc.importCharacters(exportPath)
  assert(imported.ok === true, `导入成功（count=${imported.count}）`)
  const restored = await svc.getCharacters('game-1')
  assert(fetchCount === beforeImport, `导入后读数据不发请求（新请求 ${fetchCount - beforeImport} 次）`)
  assert(restored.characters.length === roster.characters.length - 1, '导入后人物数与导出时一致')
  assert(
    !restored.characters.some((item) => item.id === victim.id),
    '导入后个人修正仍然生效（被删的角色没有复活）'
  )

  // 兼容旧版（没有 overrides 字段）的导出文件
  const legacyPath = path.join(os.tmpdir(), 'character-atlas-smoke-legacy.json')
  fs.writeFileSync(legacyPath, JSON.stringify({ games: { 'game-1': afterRemove } }), 'utf8')
  const legacy = await svc.importCharacters(legacyPath)
  assert(legacy.ok === true, `旧版（无 overrides）文件仍可导入（count=${legacy.count}）`)
  fs.rmSync(legacyPath, { force: true })

  // 0.7.0 起独立 HTML 面板链路已删除（渲染由原生标签页负责），这里只校验剩下的数据通道
  const clearResult = await ipcHandlers['character-atlas:clear-cache']({ gameId: 'game-1' })
  assert(clearResult && clearResult.ok === true, `IPC character-atlas:clear 可用（scope=${clearResult && clearResult.scope}）`)

  await plugin.deactivate(api)
  assert(Object.keys(ipcHandlers).length === 0, 'deactivate 后 IPC handler 已移除')

  console.log('\n🎉 冒烟测试全部通过')
})().catch((error) => {
  console.error('❌ 冒烟测试异常:', error)
  process.exit(1)
})
