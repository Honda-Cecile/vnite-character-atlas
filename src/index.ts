import type { IPlugin, IPluginAPI } from 'vnite-plugin-sdk'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { readConfig } from './config'
import type { PanelConfig } from './config'
import { CharacterCache } from './cache'
import { normalizeVnId, scrapeVndbCharacters } from './vndb/vndb'
import { KungalClient } from './kungal/client'
import { resolveWorkId, getWorkWithCharacters } from './kungal/resolve'
import { scrapeCharacters } from './kungal/characters'
import type { CharacterPanelData } from './kungal/characters'
import { clearCharactersMetadata, syncCharactersToMetadata } from './metadata'
import { NativeTabInjector } from './native/injector'
import { loadElectron } from './native/electron'
import { CharacterOverrides } from './overrides'
import type { CharacterEdit } from './overrides'
import { ensurePluginDoc } from './pluginKv'
import { ImageCache } from './images'

/**
 * character-atlas —— 从 KunGalgame 刮削人物数据并在 Vnite 里展示「人物」标签页。
 *
 * 生命周期（由 Vnite 主进程调用）：
 *   activate(api)  → 读配置、建 client、注册游戏事件监听 + 自定义 IPC 频道
 *   deactivate(api)→ 解绑所有监听/handler
 *
 * 事件驱动：只在 game:added（新增游戏）时后台预热缓存（需 autoOnLaunch 开启），
 * 老游戏一律不动；用户随时可以在人物栏点「开始刮削 / 重新刮削」手动触发。
 */

const NATIVE_CMD = 'character-atlas:native-cmd'
/** 标题相似度阈值：低于它就当没匹配上，避免把人物挂到别的游戏 */
const TITLE_ACCEPT = 0.8

const IPC = {
  get: 'character-atlas:get',
  refresh: 'character-atlas:refresh',
  clear: 'character-atlas:clear-cache',
  /** 渲染进程 invoke：按需把某张原图缩到 640 宽返回 data URI（详情弹窗放大用） */
  image: 'character-atlas:image',
  /** 导出 / 导入人物数据（系统文件对话框） */
  exportData: 'character-atlas:export',
  importData: 'character-atlas:import',
  /** 打开人物缓存目录 */
  openCacheDir: 'character-atlas:open-cache-dir'
} as const

/**
 * 从事件负载里挖出 gameId。
 * Vnite 各版本事件形状不一致：`{gameId}`、`{data:{gameId}}`、直接给 game 文档
 * （`_id` / `id`）都见过，所以全部兼容一遍。
 */
function gameIdOf(event: any): string {
  if (!event) return ''
  if (typeof event === 'string') return event
  const candidates = [
    event.gameId,
    event.id,
    event._id,
    event.data?.gameId,
    event.data?.id,
    event.data?._id,
    event.game?.gameId,
    event.game?._id,
    event.game?.id
  ]
  for (const value of candidates) {
    const text = String(value ?? '').trim()
    if (text) return text
  }
  return ''
}

/** 标题比较用：去掉所有空白并小写（全角空格、☆ 之类的装饰保留不动） */
function bigrams(value: string): string[] {
  const out: string[] = []
  for (let i = 0; i < value.length - 1; i += 1) out.push(value.slice(i, i + 2))
  return out
}

/** bigram Dice 相似度：对中日文标题这种短串很稳 */
function diceSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const left = bigrams(a)
  const right = bigrams(b)
  if (!left.length || !right.length) return 0
  const counts = new Map<string, number>()
  for (const gram of right) counts.set(gram, (counts.get(gram) ?? 0) + 1)
  let hit = 0
  for (const gram of left) {
    const left2 = counts.get(gram) ?? 0
    if (left2 > 0) {
      hit += 1
      counts.set(gram, left2 - 1)
    }
  }
  return (2 * hit) / (left.length + right.length)
}

function normalizeName(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase()
}

/**
 * 主进程侧的兜底黑名单：渲染进程万一又把界面文案当标题发过来，
 * 这里直接拒掉，避免拿「最近游戏」这种词去游戏库里瞎匹配。
 */
const UI_LABEL_KEYS = new Set(
  [
    '最近游戏',
    '最近添加',
    '所有游戏',
    '未收藏',
    '收藏',
    '游戏库',
    '我的游戏记录',
    '游戏记录',
    '统计数据',
    '总览',
    '概览',
    '记录',
    '存档',
    '回忆',
    '年报',
    '月报',
    '周报',
    '评分报告',
    '导出报告',
    '更新游戏元数据',
    '更新元数据',
    '开始游戏',
    '简介',
    '基本信息',
    '附加信息',
    '缺失字段',
    '要更新的字段',
    '合并策略',
    '人物',
    '角色',
    'recentgames',
    'allgames',
    'favorites',
    'library',
    'statistics',
    'overview',
    'records',
    'saves',
    'memory',
    'characters',
    'updatemetadata',
    'updategamemetadata',
    'basicinformation',
    'extrainformation'
  ].map(normalizeName)
)

function isUiLabel(value: string): boolean {
  const key = normalizeName(value)
  if (!key || key.length < 2) return true
  // 侧边栏收藏夹会带统计后缀：「生肉(80.7h, 15)」「熟肉（121h, 12）」
  if (/^[^()（）]{1,24}[（(]\s*\d/.test(value.trim())) return true
  return UI_LABEL_KEYS.has(key)
}

interface GameIdentifier {
  name: string
  originalName: string
  vndbId: string | null
  relatedSites: Array<{ label?: string; url?: string }>
}

interface GameLike {
  _id?: string
  name?: string
  metadata?: {
    name?: string
    originalName?: string
    vndbId?: string | null
    relatedSites?: Array<{ label?: string; url?: string }>
  }
}

export class CharacterPanelService {
  private readonly api: IPluginAPI
  private config: PanelConfig
  private readonly client: KungalClient
  private readonly cache: CharacterCache
  /** 用户右键删除 / 编辑过的角色：叠加在刮削结果之上 */
  private readonly overrides: CharacterOverrides

  /** 同一游戏并发请求合并，避免连点/多事件重复刮削 */
  private readonly inflight = new Map<string, Promise<CharacterPanelData>>()
  private readonly lastPanel = new Map<string, CharacterPanelData>()
  /** gameId → 可用于 DOM 文本匹配的名字（Vnite 里的 name / originalName） */
  private readonly gameNames = new Map<string, string[]>()
  /** 渲染进程已经请求过的游戏名，避免标签页反复触发刮削 */
  private readonly needCache = new Set<string>()
  private readonly unsubscribers: Array<() => void> = []
  private readonly handlers: string[] = []
  private native: NativeTabInjector | null = null
  /** 头像/立绘缓存：原生标签页没启用时（`native` 为 null）也要能用，所以自己留一份 */
  private readonly images = new ImageCache((message) => this.log(message))
  /** install() 是否已注册过（用于幂等保护） */
  private installed = false

  constructor(api: IPluginAPI, config: PanelConfig) {
    this.api = api
    this.config = config
    this.client = new KungalClient({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      nsfw: config.nsfw,
      rateLimit: config.localRateLimit
    })
    this.cache = new CharacterCache(api)
    this.overrides = new CharacterOverrides(api, (message, error) => this.log(message, error))
  }

  private log(message: string, error?: unknown): void {
    const line = error
      ? `[character-atlas] ${message} ${error instanceof Error ? error.message : String(error)}`
      : `[character-atlas] ${message}`
    if (error) console.error(line, error)
    else console.log(line)
    // Vnite 不转发插件 stdout，出问题只能靠这个文件排查：
    // %TEMP%\character-atlas\debug.log
    try {
      const dir = path.join(os.tmpdir(), 'character-atlas')
      fs.mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString()
      fs.appendFileSync(path.join(dir, 'debug.log'), `${stamp} ${line}\n`, 'utf8')
    } catch {
      /* 日志写不进去不影响主流程 */
    }
  }

  /** 注册事件监听与 IPC 频道 */
  install(): void {
    const eventBus = this.api.eventBus as any
    const ipc = this.api.ipc as any

    // 幂等：Vnite 在热重载/重复启用时可能对同一实例再调一次 activate()，
    // 此时旧监听与旧 handler 还在 ipcMain 上，直接 handle 会抛
    // 「Attempted to register a second handler for 'character-atlas:get'」
    if (this.installed) {
      this.log('install() 被重复调用，先清理上一轮注册')
      this.uninstall()
    }

    // 启动就把数据目录算出来写进日志：换机器/换便携模式出问题时能一眼看出走了哪条判定
    this.log(`图片缓存目录: ${this.images.describeDir()}`)

    if (eventBus?.on) {
      // 只在「新增游戏」时自动预热：老游戏一律不动，用户想补数据就在人物栏点「开始刮削」。
      // 不再有定时巡检 —— 后台自己发请求既费额度也不可预期。
      this.unsubscribers.push(
        eventBus.on('game:added', (event: any) => {
          const gameId = gameIdOf(event)
          if (!gameId) {
            this.log('game:added 事件里没解析出 gameId，跳过自动刮削')
            return
          }
          if (!this.config.autoOnLaunch) return
          this.log(`检测到新增游戏 ${gameId}，开始后台刮削人物`)
          void this.autoScrapeGame(gameId, 'game:added')
        })
      )
    }

    if (ipc?.handle) {
      // 模块被重新 require / 上一个实例 activate 中途抛错时，ipcMain 上可能残留同名 handler；
      // 先无条件摘掉再注册，避免 Electron 的 "second handler" 报错
      for (const channel of Object.values(IPC)) {
        try {
          ipc.removeHandler?.(channel)
        } catch (error) {
          this.log(`预清理 IPC handler 失败: ${channel}`, error)
        }
      }

      // 渲染进程 → 主进程的主通道：preload 的 ipcRenderer.send(...)
      this.registerNativeCommand()
      ipc.handle(IPC.get, async (payload: { gameId: string; force?: boolean }) => {
        if (!payload?.gameId) return null
        try {
          return await this.getCharacters(payload.gameId, { force: payload.force === true })
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) }
        }
      })
      ipc.handle(IPC.refresh, async (payload: { gameId: string }) => {
        if (!payload?.gameId) return null
        return this.getCharacters(payload.gameId, { force: true })
      })
      ipc.handle(IPC.clear, async (payload: { gameId?: string }) => {
        if (payload?.gameId) {
          await this.cache.invalidate(payload.gameId)
          this.lastPanel.delete(payload.gameId)
          return { ok: true, scope: payload.gameId }
        }
        return this.clearAllCharacters()
      })
      ipc.handle(IPC.exportData, async () => this.exportCharacters())
      ipc.handle(IPC.importData, async () => this.importCharacters())
      ipc.handle(IPC.openCacheDir, async () => this.openCacheDir())
      ipc.handle(IPC.image, async (payload: { url: string }) => {
        const url = String(payload?.url || '')
        if (!url) return null
        // 主进程没有 native 注入器（例如停用了原生标签页）时也能用，直接走图片缓存
        const large = this.native
          ? await this.native.resolveLarge(url)
          : await this.images.resolve(url, 640)
        return large ?? null
      })
      this.handlers.push(
        IPC.get,
        IPC.refresh,
        IPC.clear,
        IPC.image,
        IPC.exportData,
        IPC.importData,
        IPC.openCacheDir
      )
    }

    this.log('已注册事件监听与 IPC 频道（character-atlas:*）')
    this.installed = true
    this.installNativeTab()
  }

  /**
   * 注入原生「人物」标签页。
   * SDK 没有 UI 能力，这里直接借 Electron 的 BrowserWindow 往渲染进程塞 DOM，
   * 因此只在实际运行于 Vnite（Electron 主进程）时生效，Node 环境下静默降级。
   */
  private installNativeTab(): void {
    if (!this.config.nativeTab) {
      this.log('原生标签页注入已关闭（配置 nativeTab=false）')
      return
    }
    const native = new NativeTabInjector({
      label: this.config.nativeTabLabel,
      localImages: this.config.localImages,
      log: (message) => this.log(message),
      onRefresh: (gameId) => {
        this.needCache.clear()
        this.native?.report({ ok: true, kind: 'loading', text: '正在重新刮削…' })
        void this.getCharacters(gameId, { force: true })
          .then((panel) => {
            this.native?.report({
              ok: true,
              kind: 'ok',
              text: `✅ 已更新（${panel.source === 'vndb' ? 'VNDB' : 'KunGalgame'}）：共 ${panel.total} 人（深度补全 ${panel.enrichedCount} 人）`,
              total: panel.total,
              enriched: panel.enrichedCount,
              gameId
            })
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error)
            this.native?.report({ ok: false, error: message, text: '❌ 刮削失败：' + message })
            this.log(`标签页触发的刷新失败 (${gameId})`, error)
          })
      },
      onNeed: (gameName) => {
        void this.handleNativeNeed(gameName)
      },
      onScrape: (gameName, candidates, routeId) => {
        void this.handleNativeScrape(candidates.length ? candidates : [gameName], routeId)
      }
    })
    this.native = native
    native.start()
    if (!native.available) this.log('未检测到 Electron，原生标签页注入跳过')
  }

  /** 渲染进程报告「这个游戏没有人物数据」，按页面上的标题反查 gameId 并刮削 */
  private registerNativeCommand(): void {
    const ipc = this.api.ipc as any
    // IpcListener 的监听签名可能是 (event, payload)，也可能只给 payload，
    // 两种都接住，避免「命令到手却读不到 cmd」
    const handler = (first: any, second?: any): void => {
      const payload = second && typeof second === 'object' && 'cmd' in second ? second : first
      if (!payload || typeof payload !== 'object' || !('cmd' in payload)) return
      void this.onNativeCommand(payload)
    }
    try {
      if (typeof ipc.removeListener === 'function') ipc.removeListener(NATIVE_CMD, handler)
      ipc.on?.(NATIVE_CMD, handler)
      if (this.handlers.indexOf(NATIVE_CMD) < 0) this.handlers.push(NATIVE_CMD)
      this.log(`已监听渲染进程命令通道 ${NATIVE_CMD}`)
    } catch (error) {
      this.log(`监听 ${NATIVE_CMD} 失败`, error)
    }
  }

  private async onNativeCommand(payload: any): Promise<void> {
    const cmd = String(payload && payload.cmd ? payload.cmd : '')
    this.log(`[ipc] 收到命令: ${cmd}`)
    try {
      if (cmd === 'scrape') {
        const list = Array.isArray(payload.candidates)
          ? payload.candidates.map((value: unknown) => String(value))
          : []
        await this.handleNativeScrape(list, payload.gameId ? String(payload.gameId) : undefined)
      } else if (cmd === 'refresh') {
        const gameId = String(payload.gameId || '')
        if (!gameId) return
        this.log(`[ipc] 刷新 gameId=${gameId}`)
        await this.getCharacters(gameId, { force: true })
      } else if (cmd === 'need') {
        await this.handleNativeNeed(
          String(payload.name || ''),
          payload.gameId ? String(payload.gameId) : undefined
        )
      } else if (cmd === 'open-url') {
        const url = String(payload.url || '')
        if (!/^https?:\/\//i.test(url)) return
        this.log(`[ipc] 打开外部链接 ${url}`)
        const electron = (() => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            return require('electron') as any
          } catch (error) {
            void error
            return null
          }
        })()
        const shell = electron && electron.shell
        if (shell && typeof shell.openExternal === 'function') await shell.openExternal(url)
      } else if (cmd === 'export') {
        const result = await this.exportCharacters()
        this.native?.report(
          result.ok
            ? { ok: true, kind: 'ok', text: `✅ 已导出 ${result.count} 部作品 → ${result.path}` }
            : { ok: false, kind: 'error', text: `❌ 导出失败：${result.error || '未知原因'}` }
        )
      } else if (cmd === 'import') {
        const result = await this.importCharacters()
        this.native?.report(
          result.ok
            ? { ok: true, kind: 'ok', text: `✅ 已导入 ${result.count} 部作品的人物数据` }
            : { ok: false, kind: 'error', text: `❌ 导入失败：${result.error || '未知原因'}` }
        )
      } else if (cmd === 'remove-char') {
        const gameId = String(payload.gameId || '')
        const id = String(payload.id || '')
        if (!gameId || !id) {
          this.native?.report({ ok: false, kind: 'error', text: '❌ 删除人物需要 gameId 和角色 id' })
          return
        }
        const result = await this.overrides.remove(gameId, id)
        this.log(`已删除人物 ${id} (${gameId})，累计删除 ${result.removed} 条`)
        await this.republish(gameId)
      } else if (cmd === 'edit-char') {
        const gameId = String(payload.gameId || '')
        const id = String(payload.id || '')
        const patch = (payload.patch || {}) as CharacterEdit
        if (!gameId || !id) {
          this.native?.report({ ok: false, kind: 'error', text: '❌ 编辑人物需要 gameId 和角色 id' })
          return
        }
        await this.overrides.update(gameId, id, patch)
        this.log(`已更新人物 ${id} (${gameId}): ${Object.keys(patch).join(',')}`)
        await this.republish(gameId)
      } else if (cmd === 'reset-edits') {
        const gameId = String(payload.gameId || '')
        if (!gameId) return
        await this.overrides.reset(gameId)
        this.log(`已恢复当前作品的人物修正 (${gameId})`)
        await this.republish(gameId)
      } else if (cmd === 'clear-one') {
        const gameId = String(payload.gameId || '')
        if (!gameId) {
          this.native?.report({ ok: false, kind: 'error', text: '❌ 没拿到当前作品的 gameId' })
          return
        }
        await this.cache.invalidate(gameId)
        this.lastPanel.delete(gameId)
        this.native?.removeGame(gameId)
        this.log(`已清空当前作品的人物缓存 (${gameId})`)
        this.native?.report({ ok: true, kind: 'ok', text: '✅ 已清空当前作品的人物缓存' })
      } else if (cmd === 'clear-all') {
        const result = await this.clearAllCharacters()
        this.native?.report({
          ok: true,
          kind: 'ok',
          text: `✅ 已清空 ${result.count || 0} 部作品的人物缓存`
        })
      } else if (cmd === 'open-dir') {
        const result = await this.openCacheDir()
        this.native?.report(
          result.ok
            ? { ok: true, kind: 'ok', text: `✅ 已打开缓存目录：${result.path}` }
            : { ok: false, kind: 'error', text: `❌ ${result.error || '打不开目录'}` }
        )
      } else if (cmd === 'hello') {
        for (const [gameId, panel] of this.lastPanel) {
          await this.publishNative(gameId, panel)
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.native?.report({ ok: false, error: message, text: '❌ ' + message })
      this.log(`命令 ${cmd} 执行失败`, error)
    }
  }

  private async handleNativeNeed(gameName: string, routeGameId?: string): Promise<void> {
    const key = (routeGameId || gameName).trim()
    if (!key || this.needCache.has(key)) return
    this.needCache.add(key)
    try {
      let gameId: string | null = routeGameId || null
      if (gameId) {
        const doc = await this.api.GameDB.getGame(gameId).catch(() => null)
        if (!doc) gameId = null
      }
      if (!gameId) {
        gameId = await this.resolveGameIdByName(gameName)
      }
      if (!gameId) {
        this.needCache.delete(key)
        this.log(`标签页请求的数据无法定位到游戏: ${key}`)
        return
      }
      this.log(`标签页请求数据: ${key} → gameId=${gameId}`)
      // 这里只读缓存：自动刮削由 autoOnLaunch 决定，标签页只是「把已有数据推过来」。
      // 缓存为空时给一句明确提示，让用户去点「开始刮削」。
      const cached = await this.cache.getPanel(gameId, this.config.cacheTtlHours)
      if (cached) {
        this.lastPanel.set(gameId, cached.data)
        if (!cached.fresh && this.config.autoOnLaunch) {
          void this.scrapeAndStore(gameId).catch((error) => this.log(`后台刷新失败 (${gameId})`, error))
        }
        void this.publishNative(gameId, cached.data)
      } else {
        this.log(`标签页请求数据：缓存里没有 ${gameId}，等待用户手动刮削`)
        this.native?.report({
          ok: false,
          kind: 'error',
          text: '还没有这部作品的人物数据，点「开始刮削」抓一次（之后会一直走本地缓存）'
        })
      }
    } catch (error) {
      this.needCache.delete(key)
      this.log(`标签页请求的刮削失败 (${key})`, error)
    }
  }

  /**
   * 「更新游戏元数据」对话框里的「立即刮削」按钮。
   * 与自动流程的区别：强制刷新（忽略缓存），并把结果回传给对话框按钮。
   */
  private async handleNativeScrape(candidates: string[], routeGameId?: string): Promise<void> {
    const list = candidates.map((item) => item.trim()).filter((item) => item.length > 0)
    this.log(`请求刮削，候选标题: ${list.join(' / ') || '(空)'}${routeGameId ? ' · gameId=' + routeGameId : ''}`)
    this.native?.report({
      ok: true,
      kind: 'loading',
      text: routeGameId
        ? `正在刮削（gameId=${routeGameId}）…`
        : `正在查游戏库：${list[0] || '(无标题)'}`
    })
    let gameId: string | null = null
    // 路由里的 gameId 是唯一确定的身份来源：直接用它，绝不再靠名字猜
    if (routeGameId) {
      try {
        const doc = await this.api.GameDB.getGame(routeGameId)
        if (doc) {
          gameId = routeGameId
          this.log(`按路由 gameId=${routeGameId} 直接刮削`)
        }
      } catch (error) {
        this.log(`路由 gameId 不在游戏库里: ${routeGameId}`, error)
      }
    }
    if (!gameId) for (const candidate of list) {
      gameId = await this.resolveGameIdByName(candidate)
      if (gameId) {
        this.log(`候选「${candidate}」命中 gameId=${gameId}`)
        break
      }
    }
    let guessed = false
    if (!gameId) {
      // 只有「库里就一部作品」时才允许兜底 —— 否则会把 A 游戏的人物写进 B 游戏的栏位，
      // 正是「所有作品共用一个人物栏」的来源。多作品库里宁可报错让用户点一次概览。
      const all = (await this.api.GameDB.getAllGames().catch(() => ({}))) as Record<string, any>
      const ids = Object.keys(all || {})
      if (ids.length === 1) {
        gameId = ids[0]
        guessed = true
        this.log(`标题未命中（候选: ${list.join(' / ') || '空'}），库里只有一部作品，按它刮削 gameId=${gameId}`)
      }
    }
    if (!gameId) {
      const preview = list.slice(0, 2).map((item) => `「${item}」`).join('、')
      const message = preview
        ? `游戏库里没有和 ${preview} 对应的作品`
        : '没读到当前作品的原名/译名 —— 请先切到「概览」看一眼，再回到「人物」点开始刮削'
      this.native?.report({ ok: false, error: message, text: '❌ ' + message })
      this.log(message)
      return
    }
    try {
      for (const item of list) this.needCache.delete(item)
      this.native?.report({
        ok: true,
        kind: 'loading',
        text: guessed
          ? '⚠️ 页面里没读到「基本信息」的原名/译名，先按最近游玩的游戏尝试刮削…'
          : '正在向 KunGalgame 请求人物列表…'
      })
      this.log(`刮削命中 gameId=${gameId}`)
      const panel = await this.getCharacters(gameId, { force: true })
      const sourceLabel = panel.source === 'vndb' ? 'VNDB' : 'KunGalgame'
      const text =
        panel.characters.length === 0
          ? `⚠️ 刮削完成，但没拿到人物（作品 #${panel.workId}）`
          : `✅ 已更新（${sourceLabel}）：${panel.workName} · 共 ${panel.total} 人（深度补全 ${panel.enrichedCount} 人）`
      this.native?.report({
        ok: true,
        kind: panel.characters.length === 0 ? 'error' : 'ok',
        text,
        total: panel.total,
        enriched: panel.enrichedCount,
        gameId
      })
      this.log(text)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.native?.report({ ok: false, error: message, text: '❌ 刮削失败：' + message })
      this.log(`刮削失败 (${list.join(' / ') || '(空)'})`, error)
    }
  }

  /**
   * 用标题文本在游戏库里反查 gameId。
   *
   * 旧版是「第一个包含匹配就当中选」，只要库里有一部名字更短的作品（比如「思影」），
   * 就可能把整份人物名单安到别的游戏上。现在改成打分：完全相同 1.0、互相包含 0.9、
   * 否则用 bigram Dice，取分数最高的一部，低于阈值一律判为没匹配上，
   * 宁可让用户看到「没识别出作品名」也不要挂错游戏。
   */
  private async resolveGameIdByName(name: string): Promise<string | null> {
    if (isUiLabel(name)) return null
    const key = normalizeName(name)
    if (key.length < 2) return null
    let docs: Record<string, GameLike> | null = null
    try {
      docs = (await (this.api.GameDB as any).getAllGames()) as Record<string, GameLike> | null
    } catch (error) {
      this.log('读取游戏库失败', error)
      return null
    }
    if (!docs) return null
    const keys = [key].concat(
      key
        .split(/[|｜/／:：・]/)
        .map((part) => part.trim())
        .filter((part) => part.length >= 2)
    )
    let best: string | null = null
    let bestScore = 0
    let bestLabel = ''
    for (const gameId of Object.keys(docs)) {
      const doc = docs[gameId]
      const names = [doc?.metadata?.name, doc?.metadata?.originalName, doc?.name].filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0
      )
      for (const candidate of names) {
        const normalized = normalizeName(candidate)
        if (normalized.length < 2) continue
        let score = 0
        for (const want of keys) {
          if (normalized === want) score = Math.max(score, 1)
          else if (normalized.indexOf(want) >= 0 || want.indexOf(normalized) >= 0) {
            // 互相包含时，长度差越大越不可信（防止「思影」吃掉长标题）
            const ratio = Math.min(normalized.length, want.length) / Math.max(normalized.length, want.length)
            score = Math.max(score, 0.6 + 0.3 * ratio)
          } else {
            score = Math.max(score, diceSimilarity(normalized, want))
          }
        }
        if (score > bestScore) {
          bestScore = score
          best = gameId
          bestLabel = candidate
        }
      }
    }
    if (best && bestScore >= TITLE_ACCEPT) {
      this.log(`标题匹配「${name}」→ ${bestLabel} (${bestScore.toFixed(2)}) gameId=${best}`)
      return best
    }
    if (best) this.log(`标题匹配不足，最佳候选「${bestLabel}」仅 ${bestScore.toFixed(2)}，放弃`)
    return null
  }

  uninstall(): void {
    this.installed = false
    try {
      this.native?.stop()
    } catch (error) {
      this.log('停止原生标签页注入失败', error)
    }
    this.native = null
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      try {
        unsubscribe()
      } catch (error) {
        this.log('解绑事件监听失败', error)
      }
    }
    const ipc = this.api.ipc as any
    for (const channel of this.handlers.splice(0)) {
      try {
        ipc?.removeHandler?.(channel)
      } catch (error) {
        this.log(`移除 IPC handler 失败: ${channel}`, error)
      }
      try {
        ipc?.removeListener?.(channel)
      } catch (error) {
        void error
      }
    }
  }

  /**
   * 新增游戏后的自动刮削。
   * 新游戏必然没有缓存，所以这里只在「缓存确实不存在」时发请求，
   * 不会因为重复事件把同一部作品刮两遍。
   */
  private async autoScrapeGame(gameId: string, source: string): Promise<void> {
    if (!gameId || !this.config.autoOnLaunch) return
    if (this.inflight.has(gameId)) return
    try {
      const cached = await this.cache.getPanel(gameId, this.config.cacheTtlHours)
      if (cached && cached.data.characters.length) return
      this.log(`自动刮削人物（${source}）: ${gameId}`)
      const panel = await this.getCharacters(gameId)
      await this.publishNative(gameId, panel)
      this.log(`自动刮削完成（${source}）: ${gameId} → ${panel.total} 人`)
    } catch (error) {
      this.log(`自动刮削失败（${source}）: ${gameId}`, error)
    }
  }

  private async readIdentifier(gameId: string): Promise<GameIdentifier> {
    const game = (await this.api.GameDB.getGame(gameId)) as GameLike | null | undefined
    if (!game) throw new Error(`游戏不存在: ${gameId}`)
    const name = game.metadata?.name ?? game.name ?? ''
    const originalName = game.metadata?.originalName ?? ''
    const names = [name, originalName].map((value) => value.trim()).filter(Boolean)
    if (names.length) this.gameNames.set(gameId, names)
    return {
      name,
      originalName,
      vndbId: game.metadata?.vndbId ?? null,
      relatedSites: game.metadata?.relatedSites ?? []
    }
  }

  /** 用户改过名单后重新下发（不清缓存、不发网络请求） */
  private async republish(gameId: string): Promise<void> {
    const cached = await this.cache.getPanel(gameId, this.config.cacheTtlHours).catch(() => null)
    const panel = cached?.data || this.lastPanel.get(gameId)
    if (!panel) {
      this.native?.report({ ok: false, kind: 'error', text: '❌ 这部作品还没有人物数据' })
      return
    }
    const shaped = await this.overrides.apply(gameId, panel)
    this.lastPanel.set(gameId, shaped)
    await this.publishNative(gameId, shaped)
    this.native?.report({ ok: true, kind: 'ok', text: `✅ 已应用修改：共 ${shaped.total} 人`, total: shaped.total, gameId })
  }

  /** 把最新数据推给渲染进程的原生标签页（不阻塞主流程） */
  private async publishNative(gameId: string, panel: CharacterPanelData): Promise<void> {
    if (!this.native?.available) return
    // 用户删掉/改过的角色在每次下发前统一叠一遍：
    // 缓存里永远是刮削原样，展示层永远是「刮削 + 个人修正」
    const shaped = await this.overrides.apply(gameId, panel)
    if (!this.gameNames.has(gameId)) {
      try {
        await this.readIdentifier(gameId)
      } catch (error) {
        this.log(`读取游戏标题失败（原生标签页匹配会退化）: ${gameId}`, error)
      }
    }
    try {
      await this.native.setGame(gameId, this.gameNames.get(gameId) ?? [], shaped)
    } catch (error) {
      this.log(`推送原生标签页数据失败 (${gameId})`, error)
    }
  }

  /**
   * 取人物数据：缓存优先 → 过期用 stale 数据并后台刷新 → 未命中才同步刮削。
   */
  async getCharacters(gameId: string, options: { force?: boolean } = {}): Promise<CharacterPanelData> {
    const force = options.force === true
    if (!force) {
      const cached = await this.cache.getPanel(gameId, this.config.cacheTtlHours)
      if (cached) {
        const shaped = await this.overrides.apply(gameId, cached.data)
        this.lastPanel.set(gameId, shaped)
        void this.publishNative(gameId, shaped)
        if (!cached.fresh && this.config.autoOnLaunch) {
          // stale-while-revalidate：立刻返回旧数据，后台静默刷新（仅 autoOnLaunch 开启时）
          void this.scrapeAndStore(gameId).catch((error) => this.log(`后台刷新失败 (${gameId})`, error))
        }
        return shaped
      }
    }

    const running = this.inflight.get(gameId)
    if (running) return running

    const task = this.scrapeAndStore(gameId)
      .then((panel) => this.overrides.apply(gameId, panel))
      .finally(() => this.inflight.delete(gameId))
    this.inflight.set(gameId, task)
    return task
  }

  /** 真正的网络刮削 + 缓存 + 元数据同步 + 面板生成 */
  private async scrapeAndStore(gameId: string): Promise<CharacterPanelData> {
    const identifier = await this.readIdentifier(gameId)

    let panel: CharacterPanelData | null = null
    let kungalError: unknown = null

    try {
      panel = await this.scrapeFromKungal(gameId, identifier)
    } catch (error) {
      kungalError = error
      this.log(`KunGalgame 刮削失败: ${identifier.name}`, error)
    }

    // KunGalgame 未收录 / 没有人物时，用 VNDB 兜底（游戏带 vndbId 才有得查）
    const needFallback = !panel || panel.characters.length === 0
    if (needFallback && this.config.vndbFallback) {
      const vnId = normalizeVnId(identifier.vndbId)
      if (vnId) {
        try {
          const fallback = await scrapeVndbCharacters(vnId, {
            lang: this.config.lang,
            maxCharacters: this.config.maxCharacters,
            log: (message) => this.log(message)
          })
          if (fallback.characters.length > 0) {
            this.log(`已用 VNDB 兜底: ${vnId} → ${fallback.characters.length} 人`)
            panel = fallback
          }
        } catch (error) {
          this.log(`VNDB 兜底也失败 (${vnId})`, error)
          if (!panel && !kungalError) kungalError = error
        }
      } else if (needFallback) {
        this.log(`该游戏没有 vndbId，无法用 VNDB 兜底: ${identifier.name}`)
      }
    }

    if (!panel) {
      throw kungalError instanceof Error ? kungalError : new Error('刮削失败，没有拿到任何数据')
    }

    await this.finishScrape(gameId, panel)
    return panel
  }

  /** 缓存 / 推送 / 元数据 / HTML 这一套后处理 */
  private async finishScrape(gameId: string, panel: CharacterPanelData): Promise<void> {
    await this.cache.setPanel(gameId, panel)
    this.lastPanel.set(gameId, panel)
    void this.publishNative(gameId, panel)

    if (this.config.syncToMetadata) {
      try {
        const result = await syncCharactersToMetadata(this.api, gameId, panel)
        this.log(`已写入 Vnite 详情页附加信息：${result.written} 行人物`)
      } catch (error) {
        this.log('写入 metadata.extra 失败（不影响面板展示）', error)
      }
    } else {
      try {
        // 关掉同步时顺手把以前写进去的两个 key 清掉，避免「附加信息」里留下过期名单
        const removed = await clearCharactersMetadata(this.api, gameId)
        if (removed) this.log('已清理旧的 metadata.extra 人物条目')
      } catch (error) {
        this.log('清理 metadata.extra 失败', error)
      }
    }

  }

  /** KunGalgame（NextMoe）路径：解析作品 → 拉人物 → 补全详情 */
  private async scrapeFromKungal(gameId: string, identifier: GameIdentifier): Promise<CharacterPanelData> {
    let work
    const cachedWork = await this.cache.getWorkResolution(gameId)
    if (cachedWork) {
      try {
        work = await getWorkWithCharacters(this.client, cachedWork.workId)
      } catch (error) {
        this.log(`缓存的 workId 失效，重新解析 (${cachedWork.workId})`, error)
        await this.cache.invalidate(gameId)
      }
    }

    if (!work) {
      const resolved = await resolveWorkId(this.client, identifier)
      work = resolved.work.characters ? resolved.work : await getWorkWithCharacters(this.client, resolved.workId)
      await this.cache.setWorkResolution(gameId, {
        workId: resolved.workId,
        matchedBy: resolved.matchedBy,
        query: resolved.query
      })
      this.log(`作品匹配成功: ${identifier.name} → #${resolved.workId} (${resolved.matchedBy})`)
    }

    return scrapeCharacters(this.client, work, {
      lang: this.config.lang,
      maxCharacters: this.config.maxCharacters,
      onProgress: (done, total) => {
        if (done === total || done % 5 === 0) this.log(`人物详情补全中 ${done}/${total}`)
      }
    })
  }

  /**
   * 把所有已缓存作品的人物数据打包成 JSON。
   *
   * 导出内容包含三层：
   *   `games`     —— 刮削结果（不含个人修正，是「原始数据」）
   *   `overrides` —— 右键删除 / 编辑过的部分
   *   `images`    —— 本地缓存过的头像 / 立绘（base64），换机器或重装后不用重下
   * 三层都带走，导回来才和导出时一模一样；旧版（version 1/2）文件没有后面的层，导入时照样能吃。
   */
  async exportCharacters(target?: string): Promise<{ ok: boolean; path?: string; count?: number; error?: string }> {
    try {
      const games = (await this.api.GameDB.getAllGames()) as Record<string, unknown>
      const ids = Object.keys(games || {})
      const payload: {
        schema: string
        version: number
        exportedAt: string
        plugin: string
        games: Record<string, CharacterPanelData>
        overrides: Record<string, unknown>
        images?: Record<string, { mime: string; data: string }>
      } = {
        schema: 'character-atlas/export',
        version: 3,
        exportedAt: new Date().toISOString(),
        plugin: this.api.pluginId,
        games: {},
        overrides: {}
      }
      for (const gameId of ids) {
        const cached = await this.cache.getPanel(gameId, this.config.cacheTtlHours)
        const panel = (cached && cached.data) || this.lastPanel.get(gameId) || null
        if (panel && panel.characters && panel.characters.length) payload.games[gameId] = panel
      }
      payload.overrides = await this.overrides.exportDocs(ids)
      const count = Object.keys(payload.games).length
      if (!count) return { ok: false, error: '还没有可导出的人物数据' }

      // 图片：只打包已经下载到本地的（不联网），与缓存目录里的文件名一致
      let imageCount = 0
      if (this.config.exportImages) {
        const entries: Array<{ url: string | null; width: number; label?: string }> = []
        for (const gameId of Object.keys(payload.games)) {
          const panel = payload.games[gameId]
          const work = panel.workName ? '(' + panel.workName + ')' : ''
          for (const character of panel.characters || []) {
            const who = character.name || character.nameAlt || character.originalName || 'character'
            if (character.imageUrl) entries.push({ url: character.imageUrl, width: 168, label: who + work })
            if (character.figureUrl) entries.push({ url: character.figureUrl, width: 168, label: who + work + '-立绘' })
          }
        }
        const bundle = await this.images.collect(entries)
        imageCount = Object.keys(bundle).length
        if (imageCount) payload.images = bundle
      }

      // 传了 target 就跳过对话框（探针 / CLI 用），否则让用户选
      const targetPath = target || (await this.pickSavePath(`character-atlas-${new Date().toISOString().slice(0, 10)}.json`))
      if (!targetPath) {
        return { ok: false, error: this.dialog() ? '已取消' : '导出只能在 Vnite 里用（拿不到 Electron 的 dialog）' }
      }
      const file = targetPath
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(payload), 'utf8')
      const edits = Object.keys(payload.overrides).length
      this.log(`已导出 ${count} 部作品的人物数据（含 ${edits} 部个人修正、${imageCount} 张图片）→ ${file}`)
      return { ok: true, path: file, count }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log('导出人物数据失败', error)
      return { ok: false, error: message }
    }
  }

  async importCharacters(source?: string): Promise<{ ok: boolean; count?: number; error?: string }> {
    try {
      // 传了 source 就跳过对话框（探针 / CLI 用）
      const file = source || (await this.pickOpenPath())
      if (!file) {
        return { ok: false, error: this.dialog() ? '已取消' : '导入只能在 Vnite 里用（拿不到 Electron 的 dialog）' }
      }
      const raw = fs.readFileSync(file, 'utf8')
      const parsed = JSON.parse(raw) as {
        games?: Record<string, CharacterPanelData>
        overrides?: Record<string, unknown>
        images?: Record<string, { mime?: string; data?: string }>
      }
      const bucket = parsed && parsed.games ? parsed.games : {}
      const ids = Object.keys(bucket)
      const overrideDocs = parsed && parsed.overrides ? parsed.overrides : {}
      const imageBundle = parsed && parsed.images ? parsed.images : undefined
      if (!ids.length && !Object.keys(overrideDocs).length) return { ok: false, error: '文件里没有人物数据' }
      // 先把图片写回缓存目录，这样下面推快照时读到的就是本地文件
      const restored = await this.images.restore(imageBundle)
      let count = 0
      for (const gameId of ids) {
        const panel = bucket[gameId]
        if (!panel || !panel.characters) continue
        await this.cache.setPanel(gameId, panel)
        this.lastPanel.set(gameId, panel)
        await this.publishNative(gameId, panel)
        count += 1
      }
      const edits = await this.overrides.importDocs(overrideDocs as never)
      // 修正叠加在刮削结果之上：导完再推一次原生快照，界面才看得到删除/编辑的效果
      if (edits) {
        for (const gameId of Object.keys(overrideDocs)) {
          const panel = this.lastPanel.get(gameId)
          if (panel) await this.publishNative(gameId, panel)
        }
      }
      this.log(
        `已导入 ${count} 部作品的人物数据（含 ${edits} 部个人修正、${restored} 张图片）← ${file}`
      )
      return { ok: true, count: count + edits }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log('导入人物数据失败', error)
      return { ok: false, error: message }
    }
  }

  /** 一键清空所有人物数据（缓存 + 内存快照 + 原生面板推送） */
  async clearAllCharacters(): Promise<{ ok: boolean; count?: number }> {
    const games = (await this.api.GameDB.getAllGames()) as Record<string, unknown>
    const ids = Object.keys(games || {})
    let count = 0
    for (const gameId of ids) {
      try {
        await this.cache.invalidate(gameId)
        this.lastPanel.delete(gameId)
        count += 1
      } catch (error) {
        this.log(`清空人物缓存失败 (${gameId})`, error)
      }
    }
    this.native?.clearAll()
    // 「清空全部人物」= 真的回到初始状态：个人修正（删除 / 编辑）也一起清掉
    try {
      await this.overrides.resetAll(ids)
    } catch (error) {
      this.log('清空个人修正失败', error)
    }
    this.log(`已清空 ${count} 部作品的人物缓存`)
    return { ok: true, count }
  }

  /** 图片缓存目录（会在数据库目录下，跟着 Vnite 官方备份一起走） */
  imageDir(): string {
    return this.images.dirSync()
  }

  async openCacheDir(): Promise<{ ok: boolean; path?: string; error?: string }> {
    // 目录来自 ImageCache 自己算，不依赖原生标签页是否启用
    const dir = this.imageDir()
    const electron = loadElectron()
    if (!electron || !electron.shell) return { ok: false, error: '只能在 Vnite 里打开', path: dir }
    try {
      await electron.shell.openPath(dir)
      return { ok: true, path: dir }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), path: dir }
    }
  }

  /** 系统文件对话框（跟原生标签页无关，关掉它导出/导入也照常） */
  private dialog(): any | null {
    const electron = loadElectron()
    return electron && electron.dialog ? electron.dialog : null
  }

  private async pickSavePath(defaultName: string): Promise<string | null> {
    const dialog = this.dialog()
    if (!dialog) return null
    try {
      const result = await dialog.showSaveDialog({
        title: '导出人物数据',
        defaultPath: path.join(this.dataDirHint(), defaultName),
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
      return result && !result.canceled && result.filePath ? String(result.filePath) : null
    } catch (error) {
      this.log('打开保存对话框失败', error)
      return null
    }
  }

  private async pickOpenPath(): Promise<string | null> {
    const dialog = this.dialog()
    if (!dialog) return null
    try {
      const result = await dialog.showOpenDialog({
        title: '导入人物数据',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
      return result && !result.canceled && result.filePaths && result.filePaths[0]
        ? String(result.filePaths[0])
        : null
    } catch (error) {
      this.log('打开文件对话框失败', error)
      return null
    }
  }

  /** 导出文件默认放在 Vnite 的数据目录下，跟着 Vnite 自己的备份一起走 */
  private dataDirHint(): string {
    return path.dirname(this.images.dirSync())
  }

  updateConfig(config: PanelConfig): void {
    this.config = config
  }
}

const plugin: IPlugin = {
  async activate(api: IPluginAPI): Promise<void> {
    // 重复激活（热重载 / 重新启用）时，先把上一个实例彻底停掉：
    // 否则旧实例的 native 注入器还在往窗口塞 DOM，IPC handler 也会撞名
    const previous = (api as any).__characterPanelService as CharacterPanelService | undefined
    if (previous) {
      try {
        previous.uninstall()
        console.log('[character-atlas] 检测到上一个实例，已先卸载')
      } catch (error) {
        console.warn('[character-atlas] 卸载上一个实例失败', error)
      }
    }

    // 先确保插件文档存在（upsert，安全），再做串行读配置。
    // 不做这一步的话，Vnite 的 getValue 会在文档缺失时并发 db.put，撞 409 Document update conflict。
    await ensurePluginDoc(api)
    const config = await readConfig(api)
    const service = new CharacterPanelService(api, config)
    ;(api as any).__characterPanelService = service
    service.install()
    console.log(`[character-atlas] 已激活：lang=${config.lang} nsfw=${config.nsfw} max=${config.maxCharacters}`)

    // 激活阶段不主动发请求：数据由 game:added / IPC 触发，
    // 避免插件一启用就对着整个游戏库乱刮。
  },

  async deactivate(api: IPluginAPI): Promise<void> {
    const service = (api as any).__characterPanelService as CharacterPanelService | undefined
    service?.uninstall()
    ;(api as any).__characterPanelService = undefined
    console.log('[character-atlas] 已停用')
  }
}

export default plugin

// 便于本地探针/测试直接调用（打包后仍随 dist/index.js 一起发布，不影响 Vnite 加载）
export { NativeTabInjector }
export { scrapeVndbCharacters, normalizeVnId } from './vndb/vndb'
export { ImageCache } from './images'
export { BOOTSTRAP_SOURCE } from './native/bootstrap'
