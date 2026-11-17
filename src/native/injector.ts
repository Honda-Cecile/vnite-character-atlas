import { BOOTSTRAP_SOURCE } from './bootstrap'
import { loadElectron } from './electron'
import type { ElectronHost } from './electron'
import { ImageCache } from '../images'
import type { CharacterPanelData } from '../kungal/characters'

/**
 * 把「人物」标签页注入 Vnite 渲染进程的原生 Radix Tabs。
 *
 * SDK 层面（vnite-plugin-sdk 0.2.x）没有任何 UI 注入能力，插件 API 只有
 * ConfigDB / GameDB / PluginDB / eventBus / ipc / scraper。但 Vnite 是在主进程里
 * 用 `require()` 加载插件（`loadPluginModule`，无 vm 沙箱），所以插件可以拿到
 * electron 的 BrowserWindow，用 executeJavaScript 与渲染进程对话。
 *
 * 这条路径不依赖 preload 通道：
 *   main → renderer：executeJavaScript 注入脚本 + 推送 window.__VNCP_DATA__
 *   renderer → main：console.info 打 marker，主进程监听 webContents 'console-message'
 */

export interface NativeCharacter {
  /** 角色 id：右键「删除 / 编辑」要带回主进程，必须原样下发 */
  id: string
  n: string
  o?: string
  role?: string
  /** 卡片/详情用的本地 data URI 头像 */
  img?: string
  /** 远程原图地址：详情里点图放大时按需向主进程要大图 */
  src?: string
  /** 全身立绘（本地 data URI），弹窗里的大图 */
  fig?: string
  /** 全身立绘的远程地址（按需放大用） */
  figSrc?: string
  /** UI 语言下的译名（与主名不同时才填） */
  alt?: string
  cv?: string
  meta?: string
  /** 卡片里用的截断简介 */
  intro?: string
  /** 弹窗里用的完整简介（不截断） */
  about?: string
  /** 简介来源（bangumi / vndb / getchu …） */
  introSource?: string
  /** 简介是否机翻 */
  introMachine?: boolean
  chips?: string[]
  /** 全部特质，按分组保留（弹窗里分栏展示） */
  traits?: Array<{ g: string; n: string; s?: boolean; sp?: 'minor' | 'major' }>
  aliases?: string[]
  /** 结构化字段：性别/生日/身高/体重/三围/血型/登场作品数 */
  facts?: Array<{ k: string; v: string }>
  links?: Array<{ s: string; u: string }>
}

export interface NativeGame {
  id: string
  names: string[]
  workName: string
  /** 数据源作品 id（KunGalgame 的 #886 / VNDB 的 v702）：界面上作为徽章，便于确认没串台 */
  workId: string
  /** 数据来源，界面上作为徽章显示 */
  source: 'kungal' | 'vndb'
  total: number
  enriched: number
  fetchedAt: number
  truncated: boolean
  characters: NativeCharacter[]
}

export interface NativeSnapshot {
  /** 快照版本号：每次数据变化 +1，渲染端据此判断是否需要重绘 */
  v: number
  label: string
  games: NativeGame[]
}

export interface NativeInjectorOptions {
  /** 覆盖标签页文字（空则随页面语言：人物 / Characters） */
  label?: string
  /** 单页最多推送多少人物卡（防止 IPC 载荷过大） */
  maxCharacters?: number
  /** 简介截断长度 */
  introLimit?: number
  log?: (message: string) => void
  /** 渲染进程点了「重新刮削」 */
  onRefresh?: (gameId: string) => void
  /** 渲染进程报告「这个游戏我没有数据」，按名字反查 gameId */
  onNeed?: (gameName: string) => void
  /** 「更新游戏元数据」对话框里点了「立即刮削」 */
  onScrape?: (gameName: string, candidates: string[], gameId?: string) => void
  /** 头像是否下载到本地（默认 true：渲染端不联网，用 data URI 显示） */
  localImages?: boolean
}

const MARKER_REFRESH = '__VNCP:REFRESH:'
const MARKER_NEED = '__VNCP:NEED:'
const MARKER_SCRAPE = '__VNCP:SCRAPE:'

/**
 * 渲染进程发来的候选标题是 `encodeURIComponent(JSON.stringify(string[]))`。
 * 兼容旧格式（裸字符串），解析失败就当单个候选处理。
 */
function decodeScrape(raw: string): { candidates: string[]; gameId?: string } {
  const candidates = decodeCandidates(raw)
  let gameId: string | undefined
  try {
    const parsed: any = JSON.parse(decodeURIComponent(raw))
    if (parsed && !Array.isArray(parsed) && parsed.gameId) gameId = String(parsed.gameId)
  } catch (error) {
    void error
  }
  return { candidates: candidates, gameId: gameId }
}

function decodeCandidates(raw: string): string[] {
  if (!raw) return []
  const seen = new Set<string>()
  const out: string[] = []
  const push = (value: string): void => {
    const text = value.trim()
    if (text.length < 2) return
    if (seen.has(text)) return
    seen.add(text)
    out.push(text)
  }
  try {
    const parsed: any = JSON.parse(decodeURIComponent(raw))
    if (parsed && !Array.isArray(parsed) && Array.isArray(parsed.candidates)) {
      for (const item of parsed.candidates) push(String(item))
      return out
    }
    if (Array.isArray(parsed)) {
      for (const item of parsed) push(String(item))
    }
  } catch {
    push(raw)
  }
  return out
}
const MARKER_HELLO = '__VNCP:HELLO'

export class NativeTabInjector {
  private readonly electron: ElectronHost | null
  private readonly options: NativeInjectorOptions
  private readonly games = new Map<string, NativeGame>()
  /** 快照版本号：每次数据变化 +1，渲染端据此决定是否重绘 */
  private version = 0
  private readonly attached = new WeakSet<object>()
  /** 头像本地缓存：渲染端拿到的永远是 data URI，不联网 */
  private readonly images = new ImageCache((message) => this.log(message))
  private stopped = false
  /** 拉取式通道的定时器（每窗口一个） */
  private readonly polls: any[] = []
  private boundWindowCreated: ((event: unknown, win: unknown) => void) | null = null

  constructor(options: NativeInjectorOptions = {}) {
    this.options = options
    // 注入能力依赖 BrowserWindow；拿不到就当没有 Electron（冒烟测试里走这条）
    const host = loadElectron()
    this.electron = host && host.BrowserWindow ? host : null
  }

  /** 当前运行环境是否具备注入能力（Electron 主进程） */
  get available(): boolean {
    return this.electron != null
  }

  /** 主进程侧的 electron 句柄（导出/导入对话框、打开目录要用） */
  electronModule(): ElectronHost | null {
    return this.electron
  }

  /** 头像/立绘本地缓存目录 */
  imageDir(): string {
    return this.images.dirSync()
  }

  /** 清空全部人物快照（配合「一键清空」） */
  clearAll(): void {
    this.games.clear()
    this.version += 1
    this.broadcast()
  }

  start(): void {
    const electron = this.electron
    if (!electron) {
      this.log('当前不是 Electron 主进程，跳过原生标签页注入')
      return
    }
    this.stopped = false
    const windows: any[] = electron.BrowserWindow?.getAllWindows?.() ?? []
    for (const win of windows) this.attach(win)

    if (electron.app?.on) {
      this.boundWindowCreated = (_event: unknown, win: unknown) => this.attach(win)
      electron.app.on('browser-window-created', this.boundWindowCreated)
    }
    this.log(`原生「人物」标签页注入已启动（${windows.length} 个窗口）`)
  }

  stop(): void {
    this.stopped = true
    while (this.polls.length) {
      const timer = this.polls.pop()
      try {
        clearInterval(timer)
      } catch (error) {
        void error
      }
    }
    const electron = this.electron
    if (electron?.app?.removeListener && this.boundWindowCreated) {
      try {
        electron.app.removeListener('browser-window-created', this.boundWindowCreated)
      } catch (error) {
        this.log(`移除窗口监听失败: ${String(error)}`)
      }
      this.boundWindowCreated = null
    }
    for (const win of this.windows()) {
      const script = 'try{window.__VNCP_TEARDOWN__&&window.__VNCP_TEARDOWN__()}catch(e){}'
      void this.run(win, script)
    }
  }

  /** 用最新的人物数据覆盖某游戏的快照（头像会在这一步落到本地磁盘） */
  async setGame(gameId: string, names: string[], panel: CharacterPanelData): Promise<void> {
    if (!gameId || !panel) return
    const max = this.options.maxCharacters ?? 80
    const introLimit = this.options.introLimit ?? 320
    const merged: string[] = []
    const push = (value: string | null | undefined): void => {
      const text = (value ?? '').trim()
      if (text.length >= 2 && merged.indexOf(text) < 0) merged.push(text)
    }
    for (const name of names) push(name)
    push(panel.workName)
    push(panel.workOriginalName)
    push(panel.workLatin)

    this.games.set(gameId, {
      id: gameId,
      names: merged,
      workName: panel.workName || merged[0] || gameId,
      workId: panel.workId ? String(panel.workId) : '',
      source: panel.source,
      total: panel.total,
      enriched: panel.enrichedCount,
      fetchedAt: panel.fetchedAt,
      truncated: panel.truncated,
      characters: panel.characters.slice(0, max).map((character) => {
        const voices = character.voices
          .map((voice) => voice.name)
          .filter(Boolean)
          .join(' / ')
        const meta: string[] = []
        if (character.gender) meta.push(genderLabel(character.gender))
        if (character.birthday) meta.push(character.birthday)
        if (character.heightCm) meta.push(`${character.heightCm}cm`)
        if (character.weightKg) meta.push(`${character.weightKg}kg`)
        if (character.bloodType) meta.push(`血型 ${character.bloodType.toUpperCase()}`)
        // 卡片上的小标签：只要「非性 + 无剧透」的（弹窗里可以展开剧透标签）
        const safeTraits = character.traits.filter(
          (trait) => !trait.sexual && (trait.spoiler ?? 'none') === 'none'
        )
        const chips = safeTraits.slice(0, 8).map((trait) => trait.name)
        // 弹窗要「所有刮削来的信息」，这里把结构化的都带上
        const facts: Array<{ k: string; v: string }> = []
        if (character.gender) facts.push({ k: '性别', v: genderLabel(character.gender) })
        if (character.birthday) facts.push({ k: '生日', v: character.birthday })
        if (character.heightCm) facts.push({ k: '身高', v: `${character.heightCm}cm` })
        if (character.weightKg) facts.push({ k: '体重', v: `${character.weightKg}kg` })
        const m = character.measurements
        if (m) {
          const parts: string[] = []
          if (m.bust_cm) parts.push(`B${m.bust_cm}`)
          if (m.waist_cm) parts.push(`W${m.waist_cm}`)
          if (m.hip_cm) parts.push(`H${m.hip_cm}`)
          if (m.cup) parts.push(`${m.cup} cup`)
          if (parts.length) facts.push({ k: '三围', v: parts.join(' / ') })
        }
        if (character.bloodType) facts.push({ k: '血型', v: character.bloodType.toUpperCase() })
        if (typeof character.workCount === 'number') facts.push({ k: '登场作品', v: `${character.workCount} 部` })
        // 简介来源单独在弹窗里渲染（带「机器翻译」标注），不再占 facts 一格
        return {
          id: String(character.id || ''),
          n: character.name,
          o: character.originalName && character.originalName !== character.name ? character.originalName : undefined,
          role: character.roleLabel,
          img: character.imageUrl ?? undefined,
          src: character.imageUrl ?? undefined,
          fig: character.figureUrl ?? undefined,
          figSrc: character.figureUrl ?? undefined,
          alt: character.nameAlt || undefined,
          cv: voices || undefined,
          meta: meta.join(' · ') || undefined,
          intro: character.intro ? character.intro.slice(0, introLimit) : undefined,
          about: character.intro || undefined,
          introSource: character.introSource || undefined,
          introMachine: character.introMachine || undefined,
          chips: chips.length ? chips : undefined,
          // 卡片用 safeTraits（非性特质），弹窗要「Kungal 上看到的全部」，所以给全集并标 s
          traits: character.traits.length
            ? character.traits
                .map((trait) => ({
                  g: trait.group,
                  n: trait.name,
                  s: trait.sexual || undefined,
                  // 只给「有剧透」的标签打标，无剧透的不占字段（payload 小一截）
                  sp: trait.spoiler && trait.spoiler !== 'none' ? trait.spoiler : undefined
                }))
                .slice(0, 200)
            : undefined,
          aliases: character.aliases.length ? character.aliases.slice(0, 10) : undefined,
          facts: facts.length ? facts : undefined,
          links: character.links.length
            ? character.links
                .filter((link) => Boolean(link.url))
                .slice(0, 4)
                .map((link) => ({ s: String(link.source ?? 'link'), u: String(link.url) }))
            : undefined
        }
      })
    })

    const game = this.games.get(gameId)
    if (game && this.options.localImages !== false) {
      // 头像与立绘都下载到本地缓存后转成 data URI，渲染端不再发任何图片请求
      const sources: string[] = []
      // 文件名做成「角色名(作品名)」：头像不带后缀，立绘加 -立绘
      const labels = new Map<string, string>()
      const work = game.workName ? '(' + game.workName + ')' : ''
      for (const item of game.characters) {
        const who = item.n || item.alt || 'character'
        if (item.img) {
          sources.push(item.img)
          if (!labels.has(item.img)) labels.set(item.img, who + work)
        }
        if (item.fig) {
          sources.push(item.fig)
          if (!labels.has(item.fig)) labels.set(item.fig, who + work + '-立绘')
        }
      }
      const resolved = await this.images.resolveMany(sources, 4, labels)
      for (const character of game.characters) {
        const avatar = character.img ? resolved.get(character.img) : undefined
        if (avatar) character.img = avatar
        const figure = character.fig ? resolved.get(character.fig) : undefined
        if (figure) character.fig = figure
      }
    }

    this.version += 1
    this.broadcast()
  }

  /** 弹窗里点图放大：按需把原图缩到 640 宽后返回 data URI */
  resolveLarge(url: string): Promise<string | undefined> {
    return this.images.resolve(url, 640)
  }

  /** 头像缓存用量（供 IPC / 日志展示） */
  imageStats(): Promise<{ files: number; bytes: number }> {
    return this.images.stats()
  }

  removeGame(gameId: string): void {
    if (this.games.delete(gameId)) {
      this.version += 1
      this.broadcast()
    }
  }

  snapshot(): NativeSnapshot {
    return {
      v: this.version,
      label: (this.options.label ?? '').trim(),
      games: Array.from(this.games.values())
    }
  }

  /** 立刻把快照推给所有窗口（幂等，可在数据变化后手动调用） */
  broadcast(): void {
    const snapshot = this.snapshot()
    const payload = JSON.stringify(snapshot)
    const script =
      'window.__VNCP_DATA__=' +
      payload +
      ';try{window.__VNCP_RENDER__&&window.__VNCP_RENDER__()}catch(e){}'
    for (const win of this.windows()) void this.run(win, script)
  }

  /** 把刮削结果回传给对话框里的按钮 */
  report(payload: {
    ok: boolean
    /** 面板顶部状态条文案（成功/失败/进行中都写清楚） */
    text?: string
    kind?: 'loading' | 'ok' | 'error'
    total?: number
    enriched?: number
    error?: string
    gameId?: string
  }): void {
    const script =
      'try{window.__VNCP_STATUS__=' +
      JSON.stringify({ kind: payload.kind || (payload.ok ? 'ok' : 'error'), text: payload.text || '' }) +
      ';window.__VNCP_REPORT__&&window.__VNCP_REPORT__(' +
      JSON.stringify(payload) +
      ');window.__VNCP_RENDER__&&window.__VNCP_RENDER__()}catch(e){}'
    for (const win of this.windows()) void this.run(win, script)
  }

  private windows(): any[] {
    const electron = this.electron
    if (!electron) return []
    try {
      const list: any[] = electron.BrowserWindow?.getAllWindows?.() ?? []
      return list.filter((win) => {
        const wc = win?.webContents
        return wc && typeof wc.isDestroyed === 'function' && !wc.isDestroyed()
      })
    } catch (error) {
      this.log(`枚举窗口失败: ${String(error)}`)
      return []
    }
  }

  private attach(win: any): void {
    const wc = win?.webContents
    if (!wc || typeof wc.on !== 'function') return
    if (!this.attached.has(wc)) {
      this.attached.add(wc)
      wc.on('did-finish-load', () => {
        if (this.stopped) return
        void this.inject(win)
      })
      wc.on('console-message', (...args: any[]) => this.onConsoleMessage(args))
      wc.on('destroyed', () => this.attached.delete(wc))
      this.startPoll(win)
    }
    void this.inject(win)
  }

  /**
   * Vnite 里 console.info marker 不保证送达（实测点击后主进程毫无反应），
   * 所以再挂一条拉取式通道：定时把渲染端的 __VNCP_QUEUE__ 取回来执行。
   */
  private startPoll(win: any): void {
    const tick = (): void => {
      if (this.stopped) return
      void this.drain(win)
    }
    const timer = setInterval(tick, 700)
    if (typeof timer === 'object' && timer && typeof (timer as any).unref === 'function') {
      ;(timer as any).unref()
    }
    this.polls.push(timer)
    tick()
  }

  private async drain(win: any): Promise<void> {
    const script =
      '(function(){var q=window.__VNCP_QUEUE__||[];window.__VNCP_QUEUE__=[];' +
      'try{return JSON.stringify(q)}catch(e){return "[]"}})()'
    const raw = await this.run(win, script)
    if (typeof raw !== 'string' || raw === '[]' || raw.length < 3) return
    let items: any[]
    try {
      const parsed = JSON.parse(raw)
      items = Array.isArray(parsed) ? parsed : []
    } catch (error) {
      void error
      return
    }
    for (const item of items) {
      const cmd = String(item && item.cmd ? item.cmd : '')
      if (cmd === 'scrape') {
        const list = Array.isArray(item.candidates) ? item.candidates.map((v: any) => String(v)) : []
        const gameId = item.gameId ? String(item.gameId) : undefined
        this.log(
          `[queue] 收到刮削请求，gameId=${gameId || '-'} 候选: ${list.join(' / ') || '(空)'}`
        )
        try {
          this.options.onScrape?.(list[0] || '', list, gameId)
        } catch (error) {
          this.log(`处理刮削请求失败: ${String(error)}`)
        }
      } else if (cmd === 'refresh') {
        const gameId = String(item.gameId || '')
        this.log(`[queue] 收到刷新请求 gameId=${gameId}`)
        try {
          this.options.onRefresh?.(gameId)
        } catch (error) {
          this.log(`处理刷新请求失败: ${String(error)}`)
        }
      } else if (cmd === 'need') {
        const name = String(item.name || '')
        this.log(`[queue] 收到数据请求: ${name}`)
        try {
          this.options.onNeed?.(name)
        } catch (error) {
          this.log(`处理数据请求失败: ${String(error)}`)
        }
      } else if (cmd === 'hello') {
        this.broadcast()
      }
    }
  }

  private async inject(win: any): Promise<void> {
    if (this.stopped) return
    const wc = win?.webContents
    if (!wc) return
    try {
      await this.run(win, BOOTSTRAP_SOURCE)
      this.broadcast()
    } catch (error) {
      this.log(`注入失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async run(win: any, script: string): Promise<unknown> {
    const wc = win?.webContents
    if (!wc || typeof wc.executeJavaScript !== 'function') return null
    if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return null
    try {
      return await wc.executeJavaScript(script, true)
    } catch (error) {
      if (!this.stopped) {
        this.log(`executeJavaScript 失败: ${error instanceof Error ? error.message : String(error)}`)
      }
      return null
    }
  }

  private onConsoleMessage(args: any[]): void {
    let message = ''
    const second = args[1]
    if (second && typeof second === 'object') message = String((second as any).message ?? '')
    else if (args.length >= 3) message = String(args[2] ?? '')
    else message = String(args[0] ?? '')
    if (!message) return

    const need = message.indexOf(MARKER_NEED)
    if (need >= 0) {
      const gameName = message.slice(need + MARKER_NEED.length).trim()
      if (gameName) {
        try {
          this.options.onNeed?.(gameName)
        } catch (error) {
          this.log(`onNeed 失败: ${String(error)}`)
        }
      }
      return
    }

    const scrape = message.indexOf(MARKER_SCRAPE)
    if (scrape >= 0) {
      const raw = message.slice(scrape + MARKER_SCRAPE.length).trim()
      const decoded = decodeScrape(raw)
      if (decoded.candidates.length || decoded.gameId) {
        try {
          this.options.onScrape?.(decoded.candidates[0] || '', decoded.candidates, decoded.gameId)
        } catch (error) {
          this.log(`onScrape 失败: ${String(error)}`)
        }
      }
      return
    }

    if (message.indexOf(MARKER_HELLO) >= 0) {
      // 渲染进程刚装好注入脚本：立刻补推一次快照，消除「注入晚于首次推送」的竞态
      this.broadcast()
      return
    }

    const refresh = message.indexOf(MARKER_REFRESH)
    if (refresh >= 0) {
      const gameId = message.slice(refresh + MARKER_REFRESH.length).trim()
      if (gameId) {
        try {
          this.options.onRefresh?.(gameId)
        } catch (error) {
          this.log(`onRefresh 失败: ${String(error)}`)
        }
      }
    }
  }

  private log(message: string): void {
    this.options.log?.(`[native] ${message}`)
  }
}

function genderLabel(gender: string): string {
  const normalized = gender.toLowerCase()
  if (normalized === 'female' || normalized === 'f') return '女'
  if (normalized === 'male' || normalized === 'm') return '男'
  if (normalized === 'unknown' || normalized === 'other') return '其他'
  return gender
}
