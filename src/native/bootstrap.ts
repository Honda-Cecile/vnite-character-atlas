/**
 * 渲染进程注入脚本（以函数源码形式随主进程打包）。
 *
 * 为什么是「函数源码」而不是字符串常量：
 *   __VNCP_DATA__ 由主进程通过 executeJavaScript 写入，脚本本身在渲染进程执行，
 *   两边没有模块共享。把渲染逻辑写成真正的 TypeScript 函数，tsc 会做类型/语法校验，
 *   运行时再 `${fn.toString()}()` 注入，避免手写巨大字符串模板导致逃逸错误。
 *
 * 注入契约（渲染进程全局）：
 *   window.__VNCP_HOST__     已安装标记
 *   window.__VNCP_DATA__     主进程推送的快照 { label, games: NativeGame[] }
 *   window.__VNCP_RENDER__   手动重绘
 *   window.__VNCP_REPORT__   主进程回报刮削结果（设置页工具条状态）
 *   window.__VNCP_TEARDOWN__ 卸载（移除标签页/面板并恢复原生 tabpanel）
 *
 * 渲染 → 主进程的回控（无 preload 通道，走 console marker）：
 *   __VNCP:REFRESH:<gameId>   用户点了「重新刮削」
 *   __VNCP:NEED:<gameName>    标签页需要该游戏的数据（主进程按名字反查 gameId）
 *   __VNCP:SCRAPE:<gameName>  「更新游戏元数据」对话框里的「立即刮削」按钮
 */

export const VNCP_TAB_ID = 'vncp-tab'
export const VNCP_PANEL_ID = 'vncp-panel'
export const VNCP_STYLE_ID = 'vncp-style'

export function nativeBootstrap(): void {
  const host = window as any
  if (host.__VNCP_HOST__) {
    try {
      if (host.__VNCP_RENDER__) host.__VNCP_RENDER__()
      console.info('__VNCP:HELLO')
    ;(host.__VNCP_QUEUE__ || (host.__VNCP_QUEUE__ = [])).push({ cmd: 'hello' })
    } catch (error) {
      void error
    }
    return
  }
  host.__VNCP_HOST__ = true

  const TAB_ID = 'vncp-tab'
  const PANEL_ID = 'vncp-panel'
  const STYLE_ID = 'vncp-style'
  const MARKER_NEED = '__VNCP:NEED:'
  const MARKER_SCRAPE = '__VNCP:SCRAPE:'
  const OVERVIEW_TEXT = /^(概览|概覽|总览|總覽|概要|overview)\s*$/i
  /** 详情页才有的同组标签：记录 / 存档 / 回忆（英日同理） */
  const DETAIL_SIBLING_TEXT =
    /^(记录|紀錄|存档|存檔|回忆|回憶|record|records|save|saves|savedata|memory|memories|gallery|記録|セーブ|思い出|回想)\s*$/i

  type Lang = 'zh' | 'en' | 'ja'

  const LABELS: Record<Lang, Record<string, string>> = {
    zh: {
      tab: '人物',
      empty: '这个游戏还没有人物数据。',
      hint: '插件会在首次打开该游戏时自动刮削；也可以在下方按钮手动触发。',
      need: '正在等待人物数据…',
      start: '开始刮削',
      refresh: '重新刮削',
      loading: '刮削中…',
      cv: 'CV',
      stat: '共 {total} 人 · 已补全 {enriched} 人',
      truncated: '超出「深度刮削人数」的角色仅显示列表信息',
      source: 'KunGalgame / NextMoe',
      failed: '没能匹配到该游戏，点击「重新刮削」重试',
      diag: '页面标题：{title} · 已缓存 {count} 部作品'
    },
    en: {
      tab: 'Characters',
      empty: 'No character data for this game yet.',
      hint: 'Data is scraped the first time you open this game; you can also trigger it manually.',
      need: 'Waiting for character data…',
      start: 'Start scraping',
      refresh: 'Re-scrape',
      loading: 'Scraping…',
      cv: 'CV',
      stat: '{total} characters · {enriched} enriched',
      truncated: 'Roles beyond the depth limit show list info only',
      source: 'KunGalgame / NextMoe',
      failed: 'Game not matched yet — press Re-scrape to retry',
      diag: 'Page title: {title} · {count} games cached'
    },
    ja: {
      tab: '人物',
      empty: 'この作品の人物データはまだありません。',
      hint: '初回表示時に自動取得します。下のボタンで手動取得もできます。',
      need: '人物データを待っています…',
      start: '取得開始',
      refresh: '再取得',
      loading: '取得中…',
      cv: 'CV',
      stat: '{total} 人 · 詳細 {enriched} 人',
      truncated: '深度取得の上限を超えた人物は一覧情報のみ',
      source: 'KunGalgame / NextMoe',
      failed: '作品を特定できませんでした。再取得を押してください',
      diag: 'ページタイトル：{title} · キャッシュ {count} 件'
    }
  }

  let lang: Lang = 'zh'
  let active = false
  let scheduled = false
  // 真正活着的面板：React 重渲染有可能把我们的容器整块换掉，
  // 靠 document.getElementById 拿到的是「文档里第一个」，可能是个没人管的残骸，
  // 于是旧作品的人物会和新作品叠在一起（表现为一整排半透明卡片）。
  let livePanel: HTMLElement | null = null
  // 我们压下过的原生标签，取消激活时要按原值还回去
  const suppressed = new WeakMap<Element, { state: string | null; selected: string | null }>()

  const requested = Object.create(null) as Record<string, number>
  const boundTabs = new WeakSet<Element>()

  function label(): Record<string, string> {
    return LABELS[lang] || LABELS.zh
  }

  function text(key: string, vars?: Record<string, string | number>): string {
    const table = label()
    let out = table[key] || key
    if (vars) {
      Object.keys(vars).forEach(function (name) {
        out = out.split('{' + name + '}').join(String(vars[name]))
      })
    }
    return out
  }

  function el(tag: string, cls?: string, content?: string): HTMLElement {
    const node = document.createElement(tag)
    if (cls) node.className = cls
    if (content != null) node.textContent = content
    return node
  }

  function isDark(): boolean {
    let color = ''
    try {
      color = getComputedStyle(document.body).color || ''
    } catch (error) {
      void error
    }
    const match = color.match(/(\d+)\D+(\d+)\D+(\d+)/)
    if (!match) return true
    const lum = (Number(match[1]) + Number(match[2]) + Number(match[3])) / 3
    return lum > 140
  }

  // 字号一律用 em：基准 font-size 由 applyFont(panel) 从原生标签上取，
  // 这样用户在「设置 → 字体」里调整字号/粗细时，我们的卡片跟着一起缩放
  /**
   * 把原生标签的字体（家族 / 字号 / 粗细）抄到面板上。
   * Vnite「设置 → 字体」改的是应用根节点的 font-size/font-weight 与自定义字体族，
   * 我们自己写死 px 就会和周边界面不同步，所以这里以原生标签的 computed style 为准。
   */
  /**
   * 字体不再靠「抄标签」猜：以 Vnite 应用根节点（#root）的计算样式为准，
   * 字号用根节点字号（跟随设置里的「字体大小」），标签字号只做下限保护。
   */
  function applyFont(panel: HTMLElement): void {
    const pick = function (selector: string): HTMLElement | null {
      try {
        const node = document.querySelector(selector)
        return node instanceof HTMLElement ? node : null
      } catch (error) {
        void error
        return null
      }
    }
    const root = pick('#root') || pick('#app') || document.body
    let tabSize = 0
    let tabFont = ''
    const tabs = Array.prototype.slice.call(
      document.querySelectorAll('[role="tab"]')
    ) as HTMLElement[]
    for (let i = 0; i < tabs.length; i++) {
      if (tabs[i].id === TAB_ID) continue
      try {
        const style = window.getComputedStyle(tabs[i])
        tabFont = style.fontFamily || ''
        tabSize = parseFloat(style.fontSize) || 0
      } catch (error) {
        void error
      }
      break
    }
    try {
      const style = window.getComputedStyle(root)
      const family = (tabFont && tabFont !== '') ? tabFont : style.fontFamily
      if (family) panel.style.fontFamily = family
      const size = parseFloat(style.fontSize) || 0
      // 跟随设置里的根字号；原生标签更小时取标签字号，但保证不小于 15px（此前 14px 偏小）
      const base = Math.max(size, tabSize, 15)
      panel.style.fontSize = base + 'px'
      panel.style.fontWeight = '400'
      panel.style.letterSpacing = 'normal'
    } catch (error) {
      void error
    }
  }

  const CSS = [
    '#vncp-panel{--vncp-fg:#e7e9f0;--vncp-dim:#98a0b0;--vncp-card:rgba(255,255,255,.055);',
    '--vncp-line:rgba(255,255,255,.10);--vncp-accent:#93a4ff;--vncp-chip:rgba(255,255,255,.09);',
    'padding:16px 2px 8px;box-sizing:border-box;color:var(--vncp-fg);',
    'font-family:inherit;font-size:14px;line-height:1.55;letter-spacing:normal;}',
    '#vncp-panel[data-theme="light"]{--vncp-fg:#1e232c;--vncp-dim:#5c6472;--vncp-card:rgba(15,23,42,.045);',
    '--vncp-line:rgba(15,23,42,.10);--vncp-accent:#4c62d9;--vncp-chip:rgba(15,23,42,.06);}',
    '#vncp-panel .vncp-status{display:flex;align-items:center;gap:8px;margin:0 0 12px;padding:8px 12px;',
    'border-radius:10px;border:1px solid var(--vncp-line);background:var(--vncp-chip);font-size:1em;}',
    '#vncp-panel .vncp-status[data-kind="ok"]{color:#79d99a;}',
    '#vncp-panel .vncp-status[data-kind="error"]{color:#ff8f8f;}',
    '#vncp-panel .vncp-status[data-kind="loading"]{color:var(--vncp-fg);}',
    '#vncp-panel .vncp-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 14px;}',
    '#vncp-panel .vncp-title{font-size:1.08em;font-weight:600;letter-spacing:.2px;}',
    '#vncp-panel .vncp-stat{font-size:.86em;color:var(--vncp-dim);}',
    '#vncp-panel .vncp-src{font-size:.74em;padding:1px 6px;border-radius:6px;border:1px solid var(--vncp-line);color:var(--vncp-dim);letter-spacing:.04em;}',
    '#vncp-panel .vncp-spacer{flex:1 1 auto;}',
    '#vncp-panel .vncp-btn{cursor:pointer;border:1px solid var(--vncp-line);background:var(--vncp-chip);',
    'color:var(--vncp-fg);font-size:.86em;padding:4px 12px;border-radius:8px;transition:opacity .15s;}',
    '#vncp-panel .vncp-btn:hover{opacity:.78;}',
    '#vncp-panel .vncp-btn[disabled]{opacity:.5;cursor:default;}',
    '#vncp-panel .vncp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(19em,1fr));gap:12px;}',
    '#vncp-panel .vncp-card{display:flex;gap:12px;padding:12px;border:1px solid var(--vncp-line);',
    'border-radius:14px;background:var(--vncp-card);min-width:0;}',
    '#vncp-panel .vncp-ava{width:4.6em;height:6.2em;flex:0 0 auto;border-radius:10px;overflow:hidden;',
    'background:var(--vncp-chip);display:flex;align-items:center;justify-content:center;',
    'font-size:1.5em;color:var(--vncp-dim);}',
    '#vncp-panel .vncp-ava img{width:100%;height:100%;object-fit:cover;display:block;}',
    '#vncp-panel .vncp-body{min-width:0;flex:1 1 auto;display:flex;flex-direction:column;}',
    '#vncp-panel .vncp-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
    '#vncp-panel .vncp-name{font-size:1em;font-weight:600;line-height:1.35;word-break:break-word;}',
    '#vncp-panel .vncp-role{font-size:.78em;padding:1px 6px;border-radius:999px;border:1px solid var(--vncp-line);',
    'color:var(--vncp-accent);white-space:nowrap;}',
    '#vncp-panel .vncp-sub{font-size:.86em;color:var(--vncp-dim);margin-top:3px;word-break:break-word;}',
    '#vncp-panel .vncp-intro{font-size:.9em;line-height:1.6;margin-top:6px;color:var(--vncp-fg);opacity:.86;',
    'display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden;}',
    '#vncp-panel .vncp-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:7px;}',
    '#vncp-panel .vncp-chip{font-size:.78em;padding:1px 6px;border-radius:6px;background:var(--vncp-chip);',
    'color:var(--vncp-dim);}',
    '#vncp-panel .vncp-btn-ghost{background:transparent;padding:4px 8px;opacity:.75;}',
    '#vncp-panel .vncp-search{width:11em;font:inherit;font-size:.9em;padding:3px 9px;border-radius:8px;',
    'border:1px solid var(--vncp-line);background:var(--vncp-chip);color:var(--vncp-fg);outline:none;',
    'transition:border-color .12s ease;}',
    '#vncp-panel .vncp-search:focus{border-color:var(--vncp-accent);}',
    '#vncp-panel .vncp-search::-webkit-search-cancel-button{cursor:pointer;}',
    '#vncp-panel .vncp-cardwork{font-size:.76em;color:var(--vncp-accent);opacity:.9;margin-top:2px;}',
    '#vncp-panel .vncp-filterbar{display:flex;align-items:center;gap:10px;margin:10px 0 4px;flex-wrap:wrap;}',
    '#vncp-panel .vncp-filterlabel{font-size:.9em;color:var(--vncp-fg);padding:2px 8px;border-radius:6px;',
    'border:1px solid var(--vncp-accent);color:var(--vncp-accent);}',
    '#vncp-panel .vncp-filtercount{font-size:.84em;color:var(--vncp-dim);}',
    '#vncp-panel .vncp-chip-clear{cursor:pointer;border:1px solid var(--vncp-line);background:transparent;',
    'color:var(--vncp-dim);font-size:.8em;padding:2px 8px;border-radius:999px;}',
    '#vncp-panel .vncp-chip-clear:hover{color:var(--vncp-fg);border-color:var(--vncp-accent);}',
    '#vncp-panel .vncp-cv-hit{cursor:pointer;text-decoration:underline;text-underline-offset:3px;}',
    '#vncp-panel .vncp-trait-hit{cursor:pointer;border:1px solid transparent;border-radius:6px;',
    'background:var(--vncp-chip);color:var(--vncp-dim);font:inherit;font-size:.92em;padding:0 6px;margin:0 4px 4px 0;}',
    '#vncp-panel .vncp-trait-hit:hover{border-color:var(--vncp-accent);color:var(--vncp-fg);}',
    // 设置页的「人物数据」行：外观完全照抄上面那些原生配置行（Card + 左标题右控件），
    // 具体颜色/圆角/内边距在 adoptNativeStyle() 里从相邻的原生行拷贝过来
    '.vncp-settings-tools{box-sizing:border-box;width:100%;display:flex;align-items:center;',
    'justify-content:space-between;gap:16px;padding:20px 24px;border-radius:12px;',
    'border:1px solid rgba(128,128,128,.22);background:rgba(128,128,128,.06);font:inherit;}',
    // 下面这些只作用于「没能克隆原生行」时的兜底外观；克隆成功的行用 Vnite 自己的 class
    '.vncp-settings-tools .vncp-settings-label{display:flex;flex:1 1 auto;flex-direction:column;',
    'align-items:flex-start;justify-content:center;gap:4px;min-width:0;}',
    '.vncp-settings-tools .vncp-settings-name{font-size:14px;font-weight:500;line-height:1.2;}',
    '.vncp-settings-tools .vncp-settings-desc{font-size:14px;line-height:1.45;opacity:.7;',
    'white-space:pre-line;max-width:100%;}',
    '.vncp-settings-actions{display:flex;flex-shrink:0;flex-wrap:wrap;align-items:center;gap:8px;',
    'justify-content:flex-end;}',
    '.vncp-settings-tools .vncp-settings-btn{cursor:pointer;font:inherit;font-size:14px;white-space:nowrap;',
    'padding:6px 12px;border-radius:8px;border:1px solid rgba(128,128,128,.35);',
    'background:transparent;color:inherit;transition:background-color .12s ease,border-color .12s ease;}',
    '.vncp-settings-tools .vncp-settings-btn:hover{background:rgba(128,128,128,.16);}',
    '.vncp-settings-tools .vncp-settings-btn:active{transform:translateY(1px);}',
    '.vncp-settings-status{font-size:12px;opacity:.7;}',
    '#vncp-panel .vncp-note{font-size:.86em;color:var(--vncp-dim);margin-top:12px;}',
    '#vncp-panel .vncp-diagline{font-size:.8em;color:var(--vncp-dim);opacity:.65;margin-top:6px;}',
    '#vncp-panel .vncp-empty{padding:26px 4px;color:var(--vncp-dim);font-size:1em;line-height:1.8;}',
    '#vncp-panel .vncp-diag{margin-top:10px;font-size:.8em;opacity:.6;}',
    // 卡片可点开详情
    '#vncp-panel .vncp-card{cursor:pointer;transition:transform .12s ease,border-color .12s ease;}',
    '#vncp-panel .vncp-card:hover{transform:translateY(-1px);border-color:var(--vncp-accent);}',
    // ── 人物详情弹窗 ──
    '.vncp-modal{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;',
    'justify-content:center;padding:4vh 4vw;background:rgba(0,0,0,.5);backdrop-filter:blur(3px);}',
    '.vncp-dialog{position:relative;width:min(880px,94vw);max-height:88vh;overflow:auto;',
    // 不要滚动条：Windows 默认那条灰色宽条在深色玻璃拟态里非常扎眼，
    // 这里隐藏可见滚动条但保留滚动能力（滚轮 / 触控板 / 键盘 / 拖拽选择都照常）
    'scrollbar-width:none;-ms-overflow-style:none;overscroll-behavior:contain;',
    'border:1px solid var(--vncp-line);border-radius:16px;background:var(--vncp-modal-bg);',
    'color:var(--vncp-fg);padding:20px 22px 24px;box-shadow:0 24px 64px rgba(0,0,0,.5);',
    'font-family:inherit;font-size:inherit;}',
    '.vncp-dialog::-webkit-scrollbar{width:0;height:0;display:none;}',
    // 整个插件界面统一不要滚动条：面板列表、编辑弹窗里的 textarea、特质长列表……一律隐藏，
    // 但滚动能力全部保留（滚轮 / 触控板 / 键盘 / 拖选照常）
    '#vncp-panel,#vncp-panel *,.vncp-modal,.vncp-modal *{scrollbar-width:none;-ms-overflow-style:none;}',
    '#vncp-panel::-webkit-scrollbar,#vncp-panel *::-webkit-scrollbar,',
    '.vncp-modal::-webkit-scrollbar,.vncp-modal *::-webkit-scrollbar{width:0;height:0;display:none;}',
    '.vncp-dialog *{box-sizing:border-box;}',
    '.vncp-dialog-head{display:flex;gap:16px;align-items:flex-start;}',
    '.vncp-dialog-info{min-width:0;flex:1 1 auto;}',
    '.vncp-modal-chips{display:flex;flex-wrap:wrap;gap:4px;}',
    '.vncp-dialog-figure{flex:0 0 auto;display:flex;align-items:flex-start;}',
    '.vncp-dialog-figure img{height:16.5em;width:auto;max-width:13.5em;object-fit:contain;',
    '  border-radius:12px;',
    '  cursor:zoom-in;display:block;}',
    '.vncp-dialog-ava{width:8.4em;height:11.2em;flex:0 0 auto;border-radius:12px;overflow:hidden;',
    'background:var(--vncp-chip);display:flex;align-items:center;justify-content:center;',
    'color:var(--vncp-dim);cursor:zoom-in;}',
    '.vncp-dialog-ava span{font-size:2.4em;line-height:1;}',
    '.vncp-dialog-ava img{width:100%;height:100%;object-fit:cover;display:block;}',
    '.vncp-dialog-title{font-size:1.28em;font-weight:700;line-height:1.35;word-break:break-word;}',
    '.vncp-dialog-sub{font-size:.92em;color:var(--vncp-dim);margin-top:4px;}',
    '.vncp-dialog-close{position:absolute;top:10px;right:12px;width:2em;height:2em;border-radius:50%;',
    'border:0;background:transparent;color:var(--vncp-dim);font-size:1.1em;cursor:pointer;line-height:1;}',
    '.vncp-dialog-close:hover{background:var(--vncp-chip);color:var(--vncp-fg);}',
    '.vncp-section{margin-top:18px;}',
    '.vncp-section-title{font-size:.86em;color:var(--vncp-dim);letter-spacing:.04em;',
    'margin-bottom:8px;text-transform:uppercase;}',
    '.vncp-facts{display:grid;grid-template-columns:repeat(auto-fill,minmax(11em,1fr));gap:6px 14px;}',
    '.vncp-fact{display:flex;gap:8px;font-size:.94em;line-height:1.6;}',
    '.vncp-fact b{font-weight:500;color:var(--vncp-dim);min-width:4.4em;display:inline-block;}',
    '.vncp-about{font-size:.96em;line-height:1.85;white-space:pre-wrap;word-break:break-word;}',
    '.vncp-trait-group{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:10px;font-size:.92em;line-height:1.9;}',
    '.vncp-trait-group b{font-weight:500;color:var(--vncp-dim);margin-right:2px;flex:0 0 auto;}',
    '.vncp-trait-hit{cursor:pointer;font:inherit;font-size:.94em;padding:2px 9px;border-radius:999px;',
    'border:1px solid var(--vncp-line);background:var(--vncp-chip);color:var(--vncp-fg);line-height:1.5;',
    'transition:border-color .12s ease,background .12s ease,transform .12s ease;}',
    '.vncp-trait-hit:hover{border-color:var(--vncp-accent);color:var(--vncp-accent);transform:translateY(-1px);}',
    '.vncp-trait-hit:active{transform:none;}',
    '.vncp-trait-hit:focus-visible{outline:2px solid var(--vncp-accent);outline-offset:2px;}',
    // 剧透标签默认折叠，点「显示剧透」才展开
    '.vncp-trait-head{display:flex;align-items:center;justify-content:space-between;gap:12px;}',
    '.vncp-trait-toggle{font:inherit;font-size:.78em;line-height:1.6;padding:3px 10px;border-radius:999px;',
    'cursor:pointer;flex:0 0 auto;color:var(--vncp-dim);border:1px solid var(--vncp-line);background:transparent;}',
    '.vncp-trait-toggle:hover{color:var(--vncp-accent);border-color:var(--vncp-accent);}',
    '.vncp-trait-spoil{opacity:.66;border-bottom:1px dashed currentColor;}',
    '.vncp-dialog-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px;}',
    '.vncp-act{font:inherit;font-size:.84em;line-height:1.6;padding:5px 12px;border-radius:8px;cursor:pointer;',
    'color:var(--vncp-fg);border:1px solid var(--vncp-line);background:var(--vncp-chip);}',
    '.vncp-act:hover{border-color:var(--vncp-accent);color:var(--vncp-accent);}',
    '.vncp-act:disabled{opacity:.5;cursor:default;}',
    '.vncp-appear{display:flex;flex-direction:column;gap:4px;}',
    '.vncp-appear-row{display:flex;gap:10px;align-items:baseline;font:inherit;font-size:.92em;text-align:left;',
    'cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 8px;background:transparent;color:inherit;}',
    '.vncp-appear-row:hover{border-color:var(--vncp-accent);color:var(--vncp-accent);}',
    '.vncp-appear-row[data-link="0"]{cursor:default;}',
    '.vncp-appear-row[data-link="0"]:hover{border-color:transparent;color:inherit;}',
    '.vncp-appear-role{font-size:.86em;color:var(--vncp-dim);flex:0 0 auto;}',
    '.vncp-stats{display:grid;grid-template-columns:auto 1fr;gap:8px 18px;font-size:.94em;line-height:1.6;margin-top:6px;}',
    '.vncp-stats b{font-weight:500;color:var(--vncp-dim);white-space:nowrap;}',
    '.vncp-keymap{margin-top:10px;font-size:.82em;line-height:1.7;color:var(--vncp-dim);}',
    '.vncp-keymap kbd{font:inherit;font-size:.94em;padding:1px 6px;margin:0 2px;border-radius:5px;',
    'border:1px solid var(--vncp-line);background:var(--vncp-chip);color:var(--vncp-fg);}',
    '.vncp-modal .vncp-chip{margin:0 4px 4px 0;display:inline-block;font-size:.86em;}',
    '.vncp-link{display:inline-block;margin:0 10px 6px 0;font-size:.9em;color:var(--vncp-accent);',
    'background:none;border:0;padding:0;cursor:pointer;text-decoration:underline;',
    'text-underline-offset:3px;}',
    '.vncp-zoom{position:fixed;inset:0;z-index:2147483100;display:flex;align-items:center;',
    'justify-content:center;background:rgba(0,0,0,.88);cursor:zoom-out;}',
    '.vncp-zoom img{max-width:92vw;max-height:92vh;border-radius:10px;box-shadow:0 20px 60px rgba(0,0,0,.6);}',
    '.vncp-zoom-tip{position:fixed;bottom:24px;left:0;right:0;text-align:center;color:#cbd3e1;font-size:.9em;}',
    // 弹窗里的按钮（.vncp-btn 原本只作用于 #vncp-panel，弹窗挂在 body 上）
    '.vncp-modal .vncp-btn{cursor:pointer;padding:6px 14px;border-radius:8px;border:1px solid var(--vncp-line);',
    'background:var(--vncp-chip);color:var(--vncp-fg);font:inherit;font-size:.94em;}',
    '.vncp-modal .vncp-btn:hover{opacity:.8;}',
    '.vncp-modal .vncp-btn-primary{background:var(--vncp-accent);border-color:var(--vncp-accent);color:#fff;}',
    // 右键菜单
    '.vncp-menu{position:fixed;z-index:2147483200;min-width:11em;padding:5px;border-radius:10px;',
    'border:1px solid var(--vncp-line);background:var(--vncp-modal-bg);color:var(--vncp-fg);',
    'box-shadow:0 16px 44px rgba(0,0,0,.45);font-family:inherit;font-size:inherit;}',
    '.vncp-menu-item{display:block;width:100%;text-align:left;padding:7px 12px;border:0;border-radius:7px;',
    'background:transparent;color:inherit;font:inherit;cursor:pointer;white-space:nowrap;}',
    '.vncp-menu-item:hover{background:var(--vncp-chip);}',
    '.vncp-menu-item.vncp-danger:hover{color:#ff6b6b;}',
    // 编辑表单
    '.vncp-form{display:grid;grid-template-columns:repeat(auto-fill,minmax(13em,1fr));gap:10px 14px;margin-top:14px;}',
    '.vncp-form .vncp-field{display:flex;flex-direction:column;gap:4px;min-width:0;}',
    '.vncp-form .vncp-field.vncp-wide{grid-column:1/-1;}',
    '.vncp-field span{font-size:.86em;color:var(--vncp-dim);}',
    '.vncp-field input,.vncp-field textarea{width:100%;box-sizing:border-box;padding:6px 9px;border-radius:8px;',
    'border:1px solid var(--vncp-line);background:var(--vncp-chip);color:var(--vncp-fg);font:inherit;font-size:.94em;}',
    // resize:vertical 会在右下角留一个斜纹拖拽柄，和滚动条一样扎眼；框本身够高、也能滚，
    // 所以直接关掉拖拽柄
    '.vncp-field textarea{min-height:9em;resize:none;line-height:1.7;}',
    '.vncp-field input:focus,.vncp-field textarea:focus{outline:2px solid var(--vncp-accent);outline-offset:1px;}',
    '.vncp-form-actions{grid-column:1/-1;display:flex;justify-content:flex-end;gap:10px;margin-top:6px;}',
    // 标签页必须和原生标签待在同一排：原生是 grid(4 列) 或 flex，插第 5 个会换行
    '#vncp-tab{white-space:nowrap;}'
  ].join('')

  function ensureCss(): void {
    // 设置页没有 tablist，所以样式不能只跟着面板注入；放到 head 里全局生效
    if (document.getElementById(STYLE_ID)) return
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    ;(document.head || document.body).appendChild(style)
  }

  function tabsOf(list: HTMLElement): HTMLElement[] {
    return Array.prototype.slice.call(list.querySelectorAll('[role="tab"]')) as HTMLElement[]
  }

  /** 与某个 tablist 同属一个 Tabs 的原生面板（不要 document 全局抓，会把别处的面板一起藏掉） */
  /**
   * 所有「我们画过的面板」：除了 livePanel，任何包含 `.vncp-grid` 的 tabpanel 都是残留
   * （Radix 换游戏时会保留旧 tabpanel 节点，旧面板如果不摘掉，就出现「两张卡片墙叠在一起」）。
   */
  function stalePanels(): HTMLElement[] {
    const all = Array.prototype.slice.call(
      document.querySelectorAll('[role="tabpanel"]')
    ) as HTMLElement[]
    const out: HTMLElement[] = []
    for (let i = 0; i < all.length; i++) {
      const node = all[i]
      if (node === livePanel) continue
      if (node.id === PANEL_ID) {
        out.push(node)
        continue
      }
      if (node.querySelector('.vncp-grid') || node.querySelector('.vncp-empty')) out.push(node)
    }
    return out
  }

  function panelsOf(list: HTMLElement | null): HTMLElement[] {
    if (!list || !list.parentElement) return []
    return Array.prototype.slice.call(
      list.parentElement.querySelectorAll('[role="tabpanel"]')
    ) as HTMLElement[]
  }

  /** 取当前活动面板：优先我们记住的那个，其次才是文档里的 #vncp-panel */
  function panelEl(): HTMLElement | null {
    if (livePanel && livePanel.isConnected) return livePanel
    const found = document.getElementById(PANEL_ID) as HTMLElement | null
    livePanel = found && found.isConnected ? found : null
    return livePanel
  }

  /** 当前筛选条件：要么按特征（分组 + 名称），要么按声优 */
  function searchOf(): string {
    const query = String(host.__VNCP_SEARCH__ || '')
    if (!query) return ''
    // 搜索词带着作品的「出身」：切到别的作品时自动作废（防止搜索结果顶掉新作品的人物栏）
    const origin = String(host.__VNCP_SEARCH_ROUTE__ || '')
    const route = routeGameId()
    if (origin && route && origin !== route) {
      host.__VNCP_SEARCH__ = ''
      host.__VNCP_SEARCH_ROUTE__ = ''
      return ''
    }
    return query
  }

  function setSearch(next: string): void {
    host.__VNCP_SEARCH__ = next
    host.__VNCP_SEARCH_ROUTE__ = next ? routeGameId() : ''
    host.__VNCP_KEY__ = ''
    render()
    // 重绘会换掉 DOM，焦点与光标位置得还原，否则每敲一个字就掉焦点
    window.setTimeout(function () {
      const box = document.querySelector('#vncp-panel .vncp-search') as HTMLInputElement | null
      if (!box) return
      box.focus()
      const end = box.value.length
      try {
        box.setSelectionRange(end, end)
      } catch (error) {
        void error
      }
    }, 0)
  }

  /** 跨全部作品搜索：姓名 / 原名 / 别名 / CV / 特质名 都能命中 */
  function matchesSearch(character: any, query: string): boolean {
    const q = query.toLowerCase()
    const fields: any[] = [character.n, character.alt, character.o, character.cv]
    const aliases = (character.aliases || []) as any[]
    for (let i = 0; i < aliases.length; i++) fields.push(aliases[i])
    const traits = (character.traits || []) as any[]
    for (let i = 0; i < traits.length; i++) fields.push(traits[i] && traits[i].n)
    for (let i = 0; i < fields.length; i++) {
      const value = fields[i]
      if (value && String(value).toLowerCase().indexOf(q) >= 0) return true
    }
    return false
  }

  function searchInput(query: string): HTMLInputElement {
    const box = el('input', 'vncp-search') as HTMLInputElement
    box.type = 'search'
    box.value = query
    // 同步到 attribute：方便探针/调试从 DOM 里读到当前搜索词
    box.setAttribute('value', query)
    box.placeholder = '搜索全部作品：人物 / CV / 标签'
    box.title = '跨所有已缓存作品搜索；点开角色后点标签或声优会自动填进这里'
    box.addEventListener('input', function () {
      setSearch(box.value)
    })
    box.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') setSearch('')
    })
    return box
  }

  function filterOf(): { kind: string; g: string; n: string; label: string } | null {
    const value = host.__VNCP_FILTER__ as any
    if (!value || !value.kind) return null
    return {
      kind: String(value.kind),
      g: String(value.g || ''),
      n: String(value.n || ''),
      label: String(value.label || value.n || '')
    }
  }

  function setFilter(next: any): void {
    host.__VNCP_FILTER__ = next || null
    host.__VNCP_KEY__ = ''
    render()
  }

  function matchFilter(character: any, filter: any): boolean {
    if (!filter) return true
    if (filter.kind === 'cv') return String(character.cv || '') === filter.n
    const traits = (character.traits || []) as any[]
    for (let i = 0; i < traits.length; i++) {
      if (String(traits[i].n || '') !== filter.n) continue
      if (filter.g && String(traits[i].g || '') !== filter.g) continue
      return true
    }
    return false
  }

  /**
   * 同一个 id 在文档里只允许留一份。
   * React 重建详情页时会把我们的节点从父节点摘掉，但某些布局下它会被挂到别的容器里
   * 继续可见 —— 于是「两个人物栏叠在一起」。这里只保留 livePanel，其余全部摘除。
   */
  function pruneDuplicates(list: HTMLElement | null): void {
    const panels = Array.prototype.slice.call(
      document.querySelectorAll('#' + PANEL_ID)
    ) as HTMLElement[]
    for (let i = 0; i < panels.length; i++) {
      const node = panels[i]
      if (node === livePanel) continue
      if (!livePanel && node.isConnected) {
        livePanel = node
        continue
      }
      if (node.parentElement) node.parentElement.removeChild(node)
    }
    const scope = list || findTablist()
    const tabs = Array.prototype.slice.call(
      document.querySelectorAll('#' + TAB_ID)
    ) as HTMLElement[]
    let kept: HTMLElement | null = null
    for (let i = 0; i < tabs.length; i++) {
      const node = tabs[i]
      if (!kept && scope && scope.contains(node)) {
        kept = node
        continue
      }
      if (!kept && !scope && node.isConnected) {
        kept = node
        continue
      }
      if (node.parentElement) node.parentElement.removeChild(node)
    }
  }

  /**
   * 只认「游戏详情页」那一组标签：必须同时出现 概览 与 记录/存档/回忆 之类。
   *
   * 早期版本只要看到「概览/总览」就打高分，结果连「我的游戏记录」页
   * （总览 / 年报 / 月报 / 周报 / 评分报告 / 导出报告）也被注入了一个「人物」标签，
   * 而那个页面根本没有「当前游戏」，点了必然空白。这里用「概览 + 至少一个同组标签」
   * 的组合条件把非详情页的 tablist 全部排除。
   */
  function findTablist(): HTMLElement | null {
    const lists = Array.prototype.slice.call(
      document.querySelectorAll('[role="tablist"]')
    ) as HTMLElement[]
    for (let i = 0; i < lists.length; i++) {
      const list = lists[i]
      const tabs = tabsOf(list)
      if (tabs.length < 3 || tabs.length > 8) continue
      let hasOverview = false
      let hasSibling = false
      for (let j = 0; j < tabs.length; j++) {
        const value = (tabs[j].textContent || '').trim()
        if (OVERVIEW_TEXT.test(value)) hasOverview = true
        if (DETAIL_SIBLING_TEXT.test(value)) hasSibling = true
      }
      if (hasOverview && hasSibling) return list
    }
    return null
  }

  function detectLang(list: HTMLElement): void {
    const tabs = tabsOf(list)
    const joined = tabs
      .map(function (tab) {
        return (tab.textContent || '').trim()
      })
      .join('|')
    if (/概览|概覽|总览|總覽|记录|記錄|存档|存檔|回忆|回憶/.test(joined)) lang = 'zh'
    else if (/overview|log|save|memory/i.test(joined)) lang = 'en'
    else if (/概要|記録|セーブ|思い出/.test(joined)) lang = 'ja'
  }

  function tabText(): string {
    const custom = host.__VNCP_DATA__ && host.__VNCP_DATA__.label
    if (custom && typeof custom === 'string') return custom
    return text('tab')
  }

  /**
   * 让所有标签排成一行。
   * Vnite 的 TabsList 是 grid(4 列) 或 flex + 等宽子项，直接插第 5 个会落到第二行，
   * 所以插入后按当前标签数重算列数。
   */
  function fitRow(list: HTMLElement): void {
    const tabs = tabsOf(list)
    if (!tabs.length) return
    let display = ''
    try {
      display = getComputedStyle(list).display || ''
    } catch (error) {
      void error
    }
    const force = function (node: HTMLElement, prop: string, value: string): void {
      try {
        node.style.setProperty(prop, value, 'important')
      } catch (error) {
        void error
      }
    }
    if (display.indexOf('grid') >= 0) {
      // 5 个标签必须排在同一行：用 !important 压过 Vnite 自己的 grid-cols-4
      force(list, 'grid-template-columns', 'repeat(' + tabs.length + ', minmax(0, 1fr))')
      force(list, 'grid-auto-flow', 'row')
      force(list, 'flex-wrap', 'nowrap')
    } else {
      if (display.indexOf('flex') < 0) force(list, 'display', 'flex')
      force(list, 'flex-wrap', 'nowrap')
      for (let i = 0; i < tabs.length; i++) {
        force(tabs[i], 'flex', '1 1 0')
        force(tabs[i], 'min-width', '0')
        force(tabs[i], 'white-space', 'nowrap')
      }
    }
  }

  function createTab(): HTMLElement | null {
    const list = findTablist()
    if (!list) return null
    const tabs = tabsOf(list)
    let template: HTMLElement | null = null
    for (let i = 0; i < tabs.length; i++) {
      if (tabs[i].getAttribute('data-state') !== 'active' && tabs[i].id !== TAB_ID) {
        template = tabs[i]
        break
      }
    }
    if (!template && tabs.length) template = tabs[0]
    const tab = template ? (template.cloneNode(true) as HTMLElement) : el('button')
    tab.id = TAB_ID
    tab.setAttribute('role', 'tab')
    tab.setAttribute('type', 'button')
    tab.setAttribute('aria-selected', 'false')
    tab.setAttribute('data-state', 'inactive')
    tab.setAttribute('tabindex', '-1')
    tab.removeAttribute('aria-controls')
    tab.removeAttribute('aria-labelledby')

    const kids = Array.prototype.slice.call(tab.children) as HTMLElement[]
    let holder: HTMLElement = tab
    let longest = -1
    for (let i = 0; i < kids.length; i++) {
      const len = (kids[i].textContent || '').length
      if (len > longest) {
        longest = len
        holder = kids[i]
      }
    }
    holder.textContent = tabText()

    tab.addEventListener(
      'click',
      function (event) {
        event.preventDefault()
        event.stopPropagation()
        setActive(!active)
      },
      true
    )
    return tab
  }

  /**
   * 建立自己的内容容器。
   *
   * 早期版本是「克隆一个原生 [role=tabpanel]」，但原生面板的类名/布局属于 Radix + Tailwind，
   * 克隆体继承到 `absolute inset-0`、`overflow-hidden`、`h-0` 这类规则时会变成一块 0 高度的空区，
   * 于是「标签选中了但什么都没有」。这里改成自建 div + 内联样式，只借父节点的位置，
   * 不继承任何原生布局，保证一定有可见高度。
   */
  function ensurePanel(): void {
    if (panelEl()) return
    const natives = Array.prototype.slice.call(
      document.querySelectorAll('[role="tabpanel"]')
    ) as HTMLElement[]
    const template = natives.length ? natives[natives.length - 1] : null
    const list = findTablist()
    const hostNode = (template && template.parentElement) || (list && list.parentElement) || null
    if (!hostNode) return

    const container = document.createElement('div')
    container.id = PANEL_ID
    container.setAttribute('role', 'tabpanel')
    container.setAttribute('data-state', active ? 'active' : 'inactive')
    const parentStyle = window.getComputedStyle(hostNode)
    let layout = 'display:block;width:100%;min-height:140px;box-sizing:border-box;padding:8px 0 24px;overflow:visible;'
    if (parentStyle.display === 'grid') layout += 'grid-column:1 / -1;'
    else if (parentStyle.display === 'flex') layout += 'flex:1 1 100%;'
    try {
      const bodyFont = window.getComputedStyle(document.body).fontFamily
      if (bodyFont) layout += 'font-family:' + bodyFont.replace(/;/g, '') + ';'
    } catch (error) {
      void error
    }
    container.style.cssText = layout + (active ? 'display:block;' : 'display:none;')
    hostNode.appendChild(container)
    livePanel = container
    applyFont(container)
  }

  /**
   * 真机兜底：某些布局下原生面板的父节点是 0 高度/overflow:hidden 的盒子，
   * 我们追加进去就一起被裁掉。这里测量一次实际高度，塌陷就把容器往上挪一层。
   */
  function repairPlacement(): void {
    const panel = panelEl()
    if (!panel || panel.style.display === 'none') return
    if (panel.getAttribute('data-moved') === '1') return
    if (panel.getBoundingClientRect().height >= 40) return
    let target: HTMLElement | null = panel.parentElement
    for (let i = 0; i < 3 && target; i++) {
      if (target.clientHeight >= 120) break
      target = target.parentElement
    }
    if (!target || target === panel.parentElement) return
    panel.setAttribute('data-moved', '1')
    target.appendChild(panel)
  }

  function setActive(on: boolean): void {
    active = on
    const list = findTablist()
    const tab = document.getElementById(TAB_ID)
    const panel = panelEl()
    if (tab) {
      tab.setAttribute('aria-selected', on ? 'true' : 'false')
      tab.setAttribute('data-state', on ? 'active' : 'inactive')
      tab.setAttribute('tabindex', '0')
    }
    if (on) {
      // 视觉上要让原生标签“退选”，否则会出现两个高亮。
      // 但必须记住原值：之前是无条件把它们改成 inactive 且每轮重复，
      // 结果用户点回「概览/记录」时下划线（由 data-state 驱动的 underline 变体）
      // 刚被 Radix 画上就被我们抹掉 —— 就是「小白条消失」。
      const natives = list ? tabsOf(list) : []
      for (let i = 0; i < natives.length; i++) {
        const node = natives[i]
        if (node.id === TAB_ID) continue
        if (!suppressed.has(node)) {
          suppressed.set(node, {
            state: node.getAttribute('data-state'),
            selected: node.getAttribute('aria-selected')
          })
        }
        node.setAttribute('aria-selected', 'false')
        node.setAttribute('data-state', 'inactive')
      }
    } else {
      // 用户点的是某张原生标签：我们是在 capture 阶段先跑的，此刻 Radix 还没把
      // 目标标签设成 active。若立刻「还原」我们压下去的旧值，就会变成
      // 「概览 + 记录」两条下划线同时亮。所以延后一拍再判断：
      // 只要届时已经有原生标签是 active，就什么都别做，交给 Radix。
      const natives = list ? tabsOf(list) : []
      const pending: Array<{ node: HTMLElement; state: string | null; selected: string | null }> = []
      for (let i = 0; i < natives.length; i++) {
        const node = natives[i]
        const prev = suppressed.get(node)
        if (!prev) continue
        suppressed.delete(node)
        pending.push({ node: node, state: prev.state, selected: prev.selected })
      }
      if (pending.length) {
        window.setTimeout(function () {
          const stillList = findTablist()
          const nowTabs = stillList ? tabsOf(stillList) : []
          for (let i = 0; i < nowTabs.length; i++) {
            if (nowTabs[i].id === TAB_ID) continue
            if (nowTabs[i].getAttribute('data-state') === 'active') return
          }
          // 没有任何标签接管（比如点击被拦掉/页面结构变了），才把原来的高亮还原回去
          for (let i = 0; i < pending.length; i++) {
            const item = pending[i]
            if (item.state == null) item.node.removeAttribute('data-state')
            else item.node.setAttribute('data-state', item.state)
            if (item.selected == null) item.node.removeAttribute('aria-selected')
            else item.node.setAttribute('aria-selected', item.selected)
          }
        }, 120)
      }
    }
    // 残留面板（旧作品/旧网格）先摘掉，避免「同一屏出现两套卡片」
    const stale = stalePanels()
    for (let i = 0; i < stale.length; i++) {
      const node = stale[i]
      if (node === livePanel) continue
      if (node.parentElement) node.parentElement.removeChild(node)
    }
    const panels = panelsOf(list)
    for (let i = 0; i < panels.length; i++) {
      const current = panels[i]
      if (current.id === PANEL_ID) continue
      if (on) {
        if (current.getAttribute('data-vncp-prev') == null) {
          current.setAttribute('data-vncp-prev', current.style.display || '')
        }
        current.style.display = 'none'
      } else if (current.getAttribute('data-vncp-prev') != null) {
        const prev = current.getAttribute('data-vncp-prev') || ''
        current.style.display = prev
        current.removeAttribute('data-vncp-prev')
      }
    }
    if (panel) {
      panel.setAttribute('data-state', on ? 'active' : 'inactive')
      panel.style.display = on ? 'block' : 'none'
    }
    if (on) render()
  }

  function restoreNatives(): void {
    const list = findTablist()
    const panels = panelsOf(list)
    for (let i = 0; i < panels.length; i++) {
      const current = panels[i]
      if (current.id === PANEL_ID) continue
      if (current.getAttribute('data-vncp-prev') != null) {
        current.style.display = current.getAttribute('data-vncp-prev') || ''
        current.removeAttribute('data-vncp-prev')
      }
    }
  }

  /** 详情页右侧主面板的文本（从 tablist 往上爬到“还没盖住整个窗口”的最大祖先） */
  const PANE_LABEL = /(基本信息|基本情報|Basic information|Basic info)/i
  const SIDEBAR_HINT =
    /(最近游戏|最近添加|最近启动|所有游戏|Recently played|Recently added|All games)/i

  /**
   * 详情页作用域 = 同时包含「基本信息」的最小祖先。
   * 不能用宽度猜：Vnite 的「基本信息」是标签区右侧的兄弟列，
   * 按宽度上溯会早早停在标签容器上，结果读不到原名/译名。
   */
  function detailScope(list: HTMLElement | null): HTMLElement | null {
    let node: HTMLElement | null = list
    let fallback: HTMLElement | null = null
    for (let i = 0; i < 12 && node; i++) {
      const text = node.innerText || ''
      if (PANE_LABEL.test(text)) {
        // 这一层已经裹住左侧栏时继续往上没有意义，留作兜底
        if (!SIDEBAR_HINT.test(text)) return node
        if (!fallback) fallback = node
      }
      node = node.parentElement
    }
    return fallback
  }

  const NAME_KEY = /^(原名|譯名|译名|翻譯名|原題|英題|original name|translated name|original title)\s*[:：]?/i

  /**
   * 取「基本信息」区域的文本。
   *
   * 实测 Vnite 4.15 的「基本信息」是标签区右侧的独立列，宽度判据不可靠（旧版据此
   * 上溯会停在标签容器上，拿不到原名/译名，于是候选为空、主进程退化成「最近游玩」，
   * 把人物挂到别的游戏上）。现在改成两步：先取 detailScope，若里面没有原名/译名这类
   * 关键字，就直接扫全页 innerText —— 这些标签只出现在基本信息面板里，扫全页也不会
   * 捞到侧边栏收藏夹名。
   */
  function paneText(list: HTMLElement | null): string {
    const scope = detailScope(list)
    const scoped = scope ? scope.innerText || '' : ''
    if (scoped && NAME_KEY.test(scoped.replace(/\n/g, ' '))) return scoped
    const whole = (document.body && document.body.innerText) || ''
    if (NAME_KEY.test(whole)) return whole.slice(0, 12000)
    return scoped
  }

  /**
   * 界面自身的文案（侧边栏分组、标签名、按钮、对话框字段名……）。
   * 这些绝不能当成「当前游戏标题」发给主进程查库——
   * 早前的 bug 就是把侧边栏标题「最近游戏」当成了作品名。
   */
  const UI_LABEL =
    /^(最近游戏|最近添加|最近启动|所有游戏|全部游戏|未收藏|收藏|收藏夹|游戏库|游戏列表|我的游戏记录|游戏记录|统计数据|统计|总览|概览|概覽|概要|记录|紀錄|存档|存檔|回忆|回憶|年报|月报|周报|评分报告|导出报告|更新游戏元数据|更新元数据|开始游戏|停止游戏|启动游戏|简介|介绍|基本信息|附加信息|扩展信息|开发人员|开发商|发行商|发行日期|排序名称|原名|译名|平台|类型|标签|评分|封面|背景|图标|徽标|缺失字段|要更新的字段|合并策略|取消|确认|保存|安装|卸载|启用|停用|搜索|设置|监视器|游戏|人物|角色|Recent Games|Recently Added|All Games|Favorites|Library|Games|Statistics|Overview|Records|Saves|Memory|Memories|Yearly|Monthly|Weekly|Report|Update Game Metadata|Update Metadata|Start Game|Stop Game|Description|Basic Information|Extra Information|Developer|Developers|Publisher|Publishers|Release Date|Original Name|Translated Name|Sort Name|Platforms|Type|Tags|Rating|Cover|Banner|Icon|Missing Fields|Fields to Update|Merge Strategy|Cancel|Confirm|Save|Install|Uninstall|Enable|Disable|Search|Settings|Monitor|Characters|Character)$/i

  /** 纯符号 / 空壳文本也算界面文案 */
  function isLabel(value: string): boolean {
    const text = String(value || '').trim()
    if (!text) return true
    if (/^[·•\-–—_.…]+$/.test(text)) return true
    // 侧边栏收藏夹会带统计后缀，例如「生肉(80.7h, 15)」「熟肉（121h, 12）」
    if (/^[^()（）]{1,24}[（(]\s*\d/.test(text)) return true
    return UI_LABEL.test(text)
  }

  function headingText(): string {
    const nodes = Array.prototype.slice.call(
      document.querySelectorAll('h1,h2,h3')
    ) as HTMLElement[]
    const parts: string[] = []
    for (let i = 0; i < nodes.length && parts.length < 6; i++) {
      const value = (nodes[i].textContent || '').trim()
      if (value) parts.push(value)
    }
    return parts.join('\n')
  }

  /**
   * 从详情页「基本信息」里读原名/译名。
   * Vnite 没有路由（无 react-router），只能靠 DOM：这两个字段是详情页最稳定的文本锚点。
   * 两种排版都要吃得下：标签与值分两行（div 块级），或挤在同一行（b + span 内联）。
   */
  const NAME_KEYS = ['原名', '译名', '原題', '英題', 'Original Name', 'Translated Name', 'Original Title']
  const NAME_LEAF = /^(原名|譯名|译名|翻譯名|原題|英題|Original Name|Translated Name|Original Title)\s*[:：]?$/i

  function pushName(out: string[], value: string): void {
    const text = String(value || '')
      .split('\n')[0]
      .replace(/\s+/g, ' ')
      .trim()
    if (text.length < 2 || text.length > 120) return
    if (text === '暂无' || text === '-' || text === '—') return
    if (NAME_KEYS.indexOf(text) >= 0) return
    if (isLabel(text)) return
    if (out.indexOf(text) >= 0) return
    out.push(text)
  }

  /**
   * 从 DOM 里按「标签 → 值」取原名/译名。
   *
   * 关键点：Vnite 4.15 把「基本信息」（原名/译名）放在**概览这个 tabpanel 内部**，
   * 用户切到「人物」时概览面板被 display:none 藏起来，`innerText` 直接返回空串 ——
   * 之前就是因此读不到标题，只能回落「最近游玩」，把 A 游戏的人物画到 B 游戏页。
   * 所以这里一律用 `textContent`（不受可见性影响）做 DOM 遍历。
   */
  function namesFromDom(): string[] {
    const out: string[] = []
    const roots: Element[] = []
    const panels = document.querySelectorAll('[role="tabpanel"]')
    for (let i = 0; i < panels.length; i++) roots.push(panels[i])
    if (document.body) roots.push(document.body)

    for (let r = 0; r < roots.length; r++) {
      const root = roots[r]
      let nodes: NodeListOf<Element>
      try {
        nodes = root.querySelectorAll('div,span,p,dt,dd,td,th,label,b,strong,i,em,h4,li')
      } catch (error) {
        void error
        continue
      }
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]
        const raw = (node.textContent || '').replace(/\s+/g, ' ').trim()
        if (!raw || raw.length > 24) continue
        if (!NAME_LEAF.test(raw)) continue
        // 1) 值在下一个兄弟元素里（Vnite 用的是 label + 值 两栏）
        let value = ''
        let sib: Element | null = node.nextElementSibling
        while (sib && !value) {
          value = (sib.textContent || '').trim()
          sib = sib.nextElementSibling
        }
        // 2) 退回父元素文本里去掉标签本身
        if (!value && node.parentElement) {
          const parent = (node.parentElement.textContent || '').replace(/\s+/g, ' ').trim()
          if (parent.length > raw.length) value = parent.split(raw).join(' ').trim()
        }
        if (value) pushName(out, value)
      }
    }
    return out
  }

  /** 文本行解析：`原名 クラナド` / `原名：クラナド` / 标签值分两行都支持 */
  function namesFromText(): string[] {
    const pane = paneText(findTablist())
    if (!pane) return []
    const out: string[] = []
    const lines = pane.split('\n').map(function (line) {
      return line.replace(/\s+/g, ' ').trim()
    })
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      const key = NAME_KEYS.filter(function (item) {
        return line === item || line.indexOf(item) === 0
      })[0]
      if (!key) continue
      if (line === key) {
        pushName(out, lines[i + 1])
        continue
      }
      pushName(out, line.slice(key.length).replace(/^[\s:：·•]+/, '').trim())
    }
    return out
  }

  function namesFromPane(): string[] {
    const routeId = routeGameId()
    const dom = namesFromDom()
    if (dom.length) {
      // 记一份：概览面板被 Radix 卸载后（forceMount=false）就再也读不到原名/译名了。
      // 缓存必须带上路由 id —— 否则切到下一部作品时会拿上一部作品的名字去匹配。
      host.__VNCP_TITLE__ = { route: routeId, names: dom }
      return dom
    }
    const text = namesFromText()
    if (text.length) {
      host.__VNCP_TITLE__ = { route: routeId, names: text }
      return text
    }
    // 没有路由 id 时一律现读 DOM：这时缓存无法区分作品，复用就会串号
    if (!routeId) return []
    const cached = host.__VNCP_TITLE__
    if (cached && typeof cached === 'object' && cached.route === routeId && Array.isArray(cached.names)) {
      return (cached.names as string[]).slice()
    }
    return []
  }

  /**
   * 送给主进程的作品名候选，按可信度排序。
   * 只认「基本信息」里的原名/译名 —— 侧边栏收藏夹名、标签名、heading 一律不参与，
   * 否则会把「最近游戏」「生肉(80.7h, 15)」这种界面文案当成作品名。
   */
  function titleCandidates(): string[] {
    const out: string[] = []
    try {
      const names = namesFromPane()
      for (let i = 0; i < names.length; i++) pushName(out, names[i])
    } catch (error) {
      void error
    }
    return out
  }

  function guessTitle(): string {
    const candidates = titleCandidates()
    return candidates.length ? candidates[0] : ''
  }

  /**
   * 渲染进程 → 主进程的命令队列。
   * console.info marker 依赖 webContents 的 'console-message' 事件，在 Vnite 里
   * 并不总是送达（实测点了按钮主进程毫无动静），所以改成「主进程定时来取」这种
   * 拉模式：渲染端只管把命令塞进 __VNCP_QUEUE__，送达与否不再取决于日志通道。
   */
  function enqueue(command: Record<string, unknown>): void {
    try {
      const queue = host.__VNCP_QUEUE__ || (host.__VNCP_QUEUE__ = [])
      queue.push(command)
      if (queue.length > 20) queue.splice(0, queue.length - 20)
    } catch (error) {
      void error
    }
    // 主通道：preload 暴露的 ipcRenderer（@electron-toolkit/preload），
    // 直接进 ipcMain，比 console-message 和轮询都可靠
    try {
      const bridge = (window as any).electron
      const sender = bridge && bridge.ipcRenderer
      if (sender && typeof sender.send === 'function') {
        sender.send('character-atlas:native-cmd', command)
      } else if (bridge && typeof bridge.ipc?.send === 'function') {
        bridge.ipc.send('character-atlas:native-cmd', command)
      }
    } catch (error) {
      void error
    }
  }

  function setStatus(kind: 'loading' | 'ok' | 'error', text: string): void {
    const prev = host.__VNCP_STATUS__ || null
    host.__VNCP_STATUS__ = { kind: kind, text: text }
    // 状态没变就别重绘：renderInner 自己也会调 setStatus，
    // 不做这个判断会「渲染 → setStatus → 渲染」无限递归（Maximum call stack size exceeded）
    if (prev && prev.kind === kind && prev.text === text) return
    try {
      render()
    } catch (error) {
      void error
    }
  }

  /** 把候选标题整体发给主进程：一个匹配不上还能试下一个 */
  function requestScrape(fallback?: string): string[] {
    let candidates: string[] = []
    try {
      candidates = titleCandidates()
    } catch (error) {
      candidates = []
    }
    if (!candidates.length && fallback) candidates.push(fallback)
    // gameId 来自路由，主进程拿到它就不必再靠名字猜是哪部作品
    const gameId = routeGameId()
    enqueue({ cmd: 'scrape', candidates: candidates, gameId: gameId })
    try {
      console.info(
        MARKER_SCRAPE + encodeURIComponent(JSON.stringify({ candidates: candidates, gameId: gameId }))
      )
    } catch (error) {
      void error
    }
    return candidates
  }

  /**
   * 名字比对用的归一化：去掉所有空白（含全角空格 U+3000）、统一全/半角标点。
   * 必须做这一步 —— DOM 里取文本时会 `replace(/\\s+/g, ' ')` 把全角空格压成半角空格，
   * 而快照里的名字来自数据库原文（`彼女×彼女×彼女　ドキドキ フルスロットル！` 含 U+3000），
   * 两边直接 indexOf 会全部落空，表现就是「没能匹配到该游戏」。
   */
  function squash(value: string): string {
    return String(value || '')
      .replace(/[\s\u3000]+/g, '')
      .replace(/[!！]/g, '!')
      .replace(/[?？]/g, '?')
      .replace(/[~～〜]/g, '~')
      .replace(/[・·]/g, '')
      .toLowerCase()
  }

  function scanFor(games: any[], hay: string, current: any): any {
    if (!hay) return current
    const flat = squash(hay)
    let best = current
    for (let i = 0; i < games.length; i++) {
      const game = games[i]
      const names: string[] = game.names || []
      for (let j = 0; j < names.length; j++) {
        const key = squash(names[j])
        if (!key || key.length < 2) continue
        if (flat.indexOf(key) < 0) continue
        if (!best || key.length > best.__len) {
          best = game
          ;(best as any).__len = key.length
        }
      }
    }
    return best
  }

  /**
   * 当前详情页的游戏 id。
   * Vnite 4.15 用 TanStack Router + createHashHistory（`history: hashHistory`），
   * 地址形如 `index.html#/library/games/<gameId>/<groupId>` —— 这是唯一不靠猜的身份来源。
   * 之前靠「基本信息里的原名/译名」做文本匹配，一旦概览面板被卸载或用户刚切过游戏，
   * 就会读到上一部作品的名字，表现就是「所有作品共用一个人物栏」。
   */
  function routeGameId(): string {
    try {
      const hash = String(location.hash || '')
      const matched = hash.match(/\/library\/games\/([^/?#]+)/)
      if (matched) {
        const raw = matched[1]
        try {
          return decodeURIComponent(raw)
        } catch (error) {
          void error
          return raw
        }
      }
    } catch (error) {
      void error
    }
    return ''
  }

  function currentGame(data: any): any {
    if (!data || !data.games || !data.games.length) return null
    const games = data.games as any[]
    // 第一优先：路由里的 gameId（确定性，永不串号）
    const routeId = routeGameId()
    if (routeId) {
      for (let i = 0; i < games.length; i++) {
        if (String(games[i].id) === routeId) return games[i]
      }
      // 路由明确指向别的作品时，绝不退化成文本匹配 —— 那正是「张冠李戴」的来源
      return null
    }
    let hit: any = null
    hit = scanFor(games, headingText(), hit)
    // 名称类字段优先（精确、不会被侧边栏里别的游戏名干扰）
    const pane = namesFromPane().join('\n')
    if (!hit) hit = scanFor(games, pane, hit)
    // 绝不拿整页 innerText 兜底：侧边栏里列着库里所有游戏的名字，那样每部作品的
    // 详情页都会命中「名单里最长的那个名字」，表现就是「所有作品共用一个人物栏」。
    // 不再「只有一部作品就直接用它」：那会把 A 游戏的人物画到 B 游戏的详情页上
    if (hit) delete hit.__len
    return hit
  }

  function requestData(name: string): void {
    const routeId = routeGameId()
    const key = routeId || name
    if (!key) return
    const now = Date.now()
    const last = requested[key] || 0
    if (now - last < 20000) return
    requested[key] = now
    enqueue({ cmd: 'need', name: name, gameId: routeId })
    if (!name) return
    try {
      console.info(MARKER_NEED + name)
    } catch (error) {
      void error
    }
  }

  /** 卡片点开后的人物详情弹窗：显示全部已刮削字段，图片可点击放大 */
  function openDetail(character: any): void {
    closeDetail()
    const modal = el('div', 'vncp-modal')
    modal.id = 'vncp-modal'
    applyPanelTheme(modal)
    const dialog = el('div', 'vncp-dialog')

    const closeBtn = el('button', 'vncp-dialog-close', '×') as HTMLButtonElement
    closeBtn.type = 'button'
    closeBtn.title = '关闭'
    closeBtn.addEventListener('click', function () {
      closeDetail()
    })
    dialog.appendChild(closeBtn)

    const head = el('div', 'vncp-dialog-head')
    // Kungal 的角色卡是「全身立绘 + 头像」两张图；立绘缺失时才退回用头像当主图
    const figureUrl = String(character.fig || '')
    const figureRemote = String(character.figSrc || character.src || '')
    if (figureUrl) {
      const stage = el('div', 'vncp-dialog-figure')
      const big = document.createElement('img')
      big.src = figureUrl
      big.alt = String(character.n || '')
      big.referrerPolicy = 'no-referrer'
      big.title = '点击放大'
      big.addEventListener('click', function (event) {
        event.stopPropagation()
        openZoom(figureUrl, figureRemote || figureUrl)
      })
      stage.appendChild(big)
      head.appendChild(stage)
    }
    const avatar = el('div', 'vncp-dialog-ava')
    if (character.img) {
      const img = document.createElement('img')
      img.src = String(character.img)
      img.alt = String(character.n || '')
      img.referrerPolicy = 'no-referrer'
      avatar.appendChild(img)
      avatar.title = '点击放大'
      avatar.addEventListener('click', function (event) {
        event.stopPropagation()
        // 先把本地缩略图铺满屏幕，再向主进程要 640 宽的大图替换（不卡界面）
        openZoom(String(character.img), String(character.src || character.img))
      })
    } else {
      // 占位字用 2.4em，但只作用在这个 span 上，不影响头像框本身的尺寸
      avatar.appendChild(el('span', '', String(character.n || '?').slice(0, 1)))
    }
    head.appendChild(avatar)

    const info = el('div', 'vncp-dialog-info')
    const titleRow = el('div', 'vncp-row')
    titleRow.appendChild(el('div', 'vncp-dialog-title', String(character.n || '')))
    if (character.role) titleRow.appendChild(el('span', 'vncp-role', String(character.role)))
    info.appendChild(titleRow)
    const altName = String(character.alt || '')
    if (altName && altName !== String(character.n || '')) {
      info.appendChild(el('div', 'vncp-dialog-sub', altName))
    }
    if (character.cv) {
      const cvLine = el('div', 'vncp-dialog-sub')
      cvLine.appendChild(el('span', undefined, text('cv') + ' · '))
      const cvHit = el('span', 'vncp-cv-hit', String(character.cv))
      cvHit.title = '在所有作品里搜这位声优的角色'
      cvHit.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        closeDetail()
        // 点声优 = 直接跨所有已缓存作品搜索（用户要的是「点一下就能搜全部作品」）
        setSearch(String(character.cv))
      })
      cvLine.appendChild(cvHit)
      info.appendChild(cvLine)
    }
    if (character.meta) info.appendChild(el('div', 'vncp-dialog-sub', String(character.meta)))

    const actions = el('div', 'vncp-dialog-actions')
    const shot = el('button', 'vncp-act', '保存成图片') as HTMLButtonElement
    shot.type = 'button'
    shot.title = '把这张人物卡画成 PNG 存到本地（900×1260）'
    shot.addEventListener('click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      void saveCardImage(character, shot)
    })
    actions.appendChild(shot)
    info.appendChild(actions)
    const keymap = el('div', 'vncp-keymap')
    const key = function (text: string): HTMLElement {
      const node = document.createElement('kbd')
      node.textContent = text
      return node
    }
    const hint: Array<[string, string]> = [
      ['←', '→ 换人'],
      ['E', '编辑'],
      ['S', '出图'],
      ['T', '剧透'],
      ['Esc', '关闭']
    ]
    for (let i = 0; i < hint.length; i++) {
      if (i) keymap.appendChild(document.createTextNode(' · '))
      keymap.appendChild(key(hint[i][0]))
      keymap.appendChild(document.createTextNode(' ' + hint[i][1]))
    }
    info.appendChild(keymap)

    head.appendChild(info)
    dialog.appendChild(head)

    const facts: Array<{ k: string; v: string }> = character.facts || []
    if (facts.length) {
      const section = el('div', 'vncp-section')
      section.appendChild(el('div', 'vncp-section-title', '资料'))
      const grid = el('div', 'vncp-facts')
      for (let i = 0; i < facts.length; i++) {
        const item = el('div', 'vncp-fact')
        const key = document.createElement('b')
        key.textContent = String(facts[i].k)
        item.appendChild(key)
        item.appendChild(el('span', '', String(facts[i].v)))
        grid.appendChild(item)
      }
      section.appendChild(grid)
      dialog.appendChild(section)
    }

    if (character.aliases && character.aliases.length) {
      const section = el('div', 'vncp-section')
      section.appendChild(el('div', 'vncp-section-title', '别名'))
      const box = el('div', 'vncp-modal-chips')
      for (let i = 0; i < character.aliases.length; i++) {
        box.appendChild(el('span', 'vncp-chip', String(character.aliases[i])))
      }
      section.appendChild(box)
      dialog.appendChild(section)
    }

    const about = character.about || character.intro || ''
    if (character.introSource) {
      const origin = el('div', 'vncp-section')
      origin.appendChild(el('div', 'vncp-section-title', '简介来源'))
      const label = String(character.introSource)
      const pretty = label.charAt(0).toUpperCase() + label.slice(1)
      origin.appendChild(
        el('div', 'vncp-about', pretty + (character.introMachine ? '（机器翻译）' : ''))
      )
      dialog.appendChild(origin)
    }
    if (about) {
      const section = el('div', 'vncp-section')
      section.appendChild(el('div', 'vncp-section-title', '简介'))
      // 源简介里段落之间常有 2~3 个空行，弹窗里收一下，别让卡片间空隙太大
      const tidy = String(about)
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{2,}/g, '\n')
        .trim()
      section.appendChild(el('div', 'vncp-about', tidy))
      dialog.appendChild(section)
    }

    type DialogTrait = { g?: string; n: string; s?: boolean; sp?: string }
    const traits = ((character.traits || []) as DialogTrait[]).filter(function (item) {
      return item && item.n
    })
    if (traits.length) {
      // 剧透标签不单独成块：直接并进按类别分组的同一片标签里，默认只是「看不见」，
      // 点右上角按钮就地显示 / 收起 —— 视觉上始终是一整排标签，不破坏排版。
      let plainCount = 0
      const spoil: HTMLElement[] = []
      for (let i = 0; i < traits.length; i++) {
        if (!traits[i].sp) plainCount++
      }

      const section = el('div', 'vncp-section')
      const head = el('div', 'vncp-trait-head')
      const title = el('div', 'vncp-section-title', '特征（' + plainCount + '）')
      head.appendChild(title)
      section.appendChild(head)

      const order: string[] = []
      const bucket: Record<string, DialogTrait[]> = {}
      for (let i = 0; i < traits.length; i++) {
        const group = String(traits[i].g || '其他')
        if (!bucket[group]) {
          bucket[group] = []
          order.push(group)
        }
        bucket[group].push(traits[i])
      }

      for (let i = 0; i < order.length; i++) {
        const line = el('div', 'vncp-trait-group')
        const label = document.createElement('b')
        label.textContent = order[i]
        line.appendChild(label)
        const items = bucket[order[i]]
        for (let j = 0; j < items.length; j++) {
          const item = items[j]
          const hidden = !!item.sp
          // 性相关特质在 Kungal 上会单独成组（被动(性) 等），这里标「·性」而不是丢掉
          const chip = el(
            'button',
            'vncp-trait-hit' + (hidden ? ' vncp-trait-spoil' : ''),
            item.n + (item.s ? '·性' : '')
          ) as HTMLButtonElement
          chip.type = 'button'
          chip.title = (hidden ? '含剧透 · 只看「' : '只看「') + item.n + '」的角色'
          if (hidden) {
            chip.style.display = 'none'
            chip.setAttribute('data-spoiler', '1')
            spoil.push(chip)
          }
          chip.addEventListener('click', function (event) {
            event.preventDefault()
            event.stopPropagation()
            closeDetail()
            // 用标签名做全局搜索：命中所有作品里带这个标签的角色
            setSearch(String(item.n))
          })
          line.appendChild(chip)
        }
        section.appendChild(line)
      }

      if (spoil.length) {
        const toggle = el('button', 'vncp-trait-toggle') as HTMLButtonElement
        toggle.type = 'button'
        toggle.setAttribute('data-open', '0')
        toggle.textContent = '显示剧透（' + spoil.length + '）'
        toggle.title = '这些标签会透露剧情走向，默认收起；点一下就地展开'
        toggle.addEventListener('click', function (event) {
          event.preventDefault()
          event.stopPropagation()
          const opened = toggle.getAttribute('data-open') === '1'
          for (let i = 0; i < spoil.length; i++) {
            spoil[i].style.display = opened ? 'none' : ''
          }
          toggle.setAttribute('data-open', opened ? '0' : '1')
          toggle.textContent = (opened ? '显示剧透（' : '收起剧透（') + spoil.length + '）'
          title.textContent = '特征（' + (opened ? plainCount : plainCount + spoil.length) + '）'
        })
        head.appendChild(toggle)
      }

      dialog.appendChild(section)
    }

    if (character.links && character.links.length) {
      const section = el('div', 'vncp-section')
      section.appendChild(el('div', 'vncp-section-title', '来源'))
      for (let i = 0; i < character.links.length; i++) {
        const link = character.links[i]
        const btn = el('button', 'vncp-link', String(link.s || 'link')) as HTMLButtonElement
        btn.type = 'button'
        btn.title = String(link.u || '')
        btn.addEventListener('click', function (event) {
          event.preventDefault()
          event.stopPropagation()
          if (link.u) openExternal(String(link.u))
        })
        section.appendChild(btn)
      }
      dialog.appendChild(section)
    }

    appendAppearances(dialog, character)

    // 弹窗挂在 body 上，拿不到 #vncp-panel 作用域里的 CSS 变量，这里显式搬一份
    const source = document.getElementById('vncp-panel')
    applyPanelTheme(modal)
    modal.style.fontFamily = source ? window.getComputedStyle(source).fontFamily : 'inherit'
    modal.style.fontSize = source ? window.getComputedStyle(source).fontSize : '15px'

    modal.appendChild(dialog)
    modal.addEventListener('click', function (event) {
      if (event.target === modal) closeDetail()
    })
    document.body.appendChild(modal)
    // 记下这一批角色（当前作品的全员，或搜索结果），←→ 就地换人
    const siblings = detailSiblings()
    let index = -1
    for (let i = 0; i < siblings.length; i++) {
      if (String(siblings[i] && siblings[i].id) === String(character.id)) {
        index = i
        break
      }
    }
    host.__VNCP_DETAIL__ = { list: index >= 0 ? siblings : [character], index: index >= 0 ? index : 0 }
    document.addEventListener('keydown', onDetailKey, true)
  }

  /** 详情弹窗里的那批角色：搜索态用搜索结果，否则用当前作品全员 */
  function detailSiblings(): any[] {
    const data = host.__VNCP_DATA__ || null
    if (!data || !Array.isArray(data.games)) return []
    const query = searchOf().trim()
    if (query) {
      const hits: any[] = []
      for (let i = 0; i < data.games.length; i++) {
        const pool = (data.games[i].characters || []) as any[]
        for (let j = 0; j < pool.length; j++) {
          if (matchesSearch(pool[j], query)) hits.push(pool[j])
        }
      }
      return hits
    }
    const game = currentGame(data)
    return game && Array.isArray(game.characters) ? game.characters : []
  }

  /**
   * 详情弹窗的快捷键。列表页不再抢方向键 —— 用鼠标点卡片本来就更快，
   * 真正需要键盘的是「看完这个人接着看下一个」「顺手改一下」「顺手出张图」。
   */
  function onDetailKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      if (document.getElementById('vncp-zoom')) {
        closeZoom()
        return
      }
      closeDetail()
      return
    }

    const state = host.__VNCP_DETAIL__ as { list: any[]; index: number } | undefined
    if (!state || !state.list || !state.list.length) return
    const current = state.list[state.index]
    if (!current) return

    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown'
    const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
    if (forward || backward) {
      const next = state.index + (forward ? 1 : -1)
      if (next < 0 || next >= state.list.length) return
      event.preventDefault()
      event.stopPropagation()
      const target = state.list[next]
      if (!target) return
      // 就地换人：关掉旧弹窗，用同一套结构重画（滚动位置回到顶部，符合「翻到下一张」的预期）
      closeDetail()
      openDetail(target)
      return
    }

    const key = String(event.key || '').toLowerCase()
    if (key === 'e') {
      event.preventDefault()
      event.stopPropagation()
      closeDetail()
      openEditor(current)
      return
    }
    if (key === 's') {
      event.preventDefault()
      event.stopPropagation()
      const btn = document.querySelector('#vncp-modal .vncp-dialog-actions .vncp-act') as HTMLButtonElement | null
      void saveCardImage(current, btn || undefined)
      return
    }
    if (key === 't') {
      const toggle = document.querySelector('#vncp-modal .vncp-trait-toggle') as HTMLButtonElement | null
      if (!toggle) return
      event.preventDefault()
      event.stopPropagation()
      toggle.click()
    }
  }

  function closeDetail(): void {
    const node = document.getElementById('vncp-modal')
    if (node && node.parentNode) node.parentNode.removeChild(node)
    document.removeEventListener('keydown', onDetailKey, true)
  }

  /** 图片放大：先用缩略图立即显示，再向主进程请求 640 宽版本替换 */
  function openZoom(small: string, remote: string): void {
    closeZoom()
    const layer = el('div', 'vncp-zoom')
    layer.id = 'vncp-zoom'
    const img = document.createElement('img')
    img.src = small
    img.alt = ''
    img.referrerPolicy = 'no-referrer'
    layer.appendChild(img)
    const tip = el('div', 'vncp-zoom-tip', '正在加载高清图…（点击任意处或按 Esc 关闭）')
    layer.appendChild(tip)
    layer.addEventListener('click', function () {
      closeZoom()
    })
    document.body.appendChild(layer)

    try {
      const bridge = (window as any).electron
      const ipc = bridge && bridge.ipcRenderer
      if (!ipc || typeof ipc.invoke !== 'function' || !remote || remote.indexOf('data:') === 0) {
        tip.textContent = '点击任意处或按 Esc 关闭'
        return
      }
      Promise.resolve(ipc.invoke('character-atlas:image', { url: remote }))
        .then(function (uri: any) {
          if (typeof uri === 'string' && uri.indexOf('data:') === 0) img.src = uri
        })
        .catch(function (error: any) {
          void error
        })
        .then(function () {
          tip.textContent = '点击任意处或按 Esc 关闭'
        })
    } catch (error) {
      void error
      tip.textContent = '点击任意处或按 Esc 关闭'
    }
  }

  function closeZoom(): void {
    const node = document.getElementById('vncp-zoom')
    if (node && node.parentNode) node.parentNode.removeChild(node)
  }

  /** 外部链接交给主进程 shell.openExternal，避免把 Vnite 主窗口导航走 */
  function openExternal(url: string): void {
    enqueue({ cmd: 'open-url', url: url })
  }

  /**
   * 弹窗 / 菜单都挂在 body 上，拿不到 #vncp-panel 作用域里的 CSS 变量，
   * 这里把面板当前的主题变量显式搬一份过去（浅色/深色都跟面板一致）。
   */
  function applyPanelTheme(node: HTMLElement): void {
    const source = document.getElementById('vncp-panel')
    const lightMode = !!(source && source.getAttribute('data-theme') === 'light')
    if (source) {
      const computed = window.getComputedStyle(source)
      const names = ['--vncp-fg', '--vncp-dim', '--vncp-card', '--vncp-line', '--vncp-accent', '--vncp-chip']
      for (let i = 0; i < names.length; i++) {
        const value = computed.getPropertyValue(names[i])
        if (value) node.style.setProperty(names[i], value.trim())
      }
    }
    if (!node.style.getPropertyValue('--vncp-fg')) node.style.setProperty('--vncp-fg', lightMode ? '#1e232c' : '#e7e9f0')
    if (!node.style.getPropertyValue('--vncp-dim')) node.style.setProperty('--vncp-dim', lightMode ? '#5c6472' : '#98a0b0')
    if (!node.style.getPropertyValue('--vncp-line'))
      node.style.setProperty('--vncp-line', lightMode ? 'rgba(15,23,42,.14)' : 'rgba(255,255,255,.12)')
    if (!node.style.getPropertyValue('--vncp-chip'))
      node.style.setProperty('--vncp-chip', lightMode ? 'rgba(15,23,42,.06)' : 'rgba(255,255,255,.08)')
    if (!node.style.getPropertyValue('--vncp-accent')) node.style.setProperty('--vncp-accent', '#7aa2ff')
    node.style.setProperty('--vncp-modal-bg', lightMode ? 'rgba(250,250,252,.98)' : 'rgba(24,26,32,.98)')
  }

  /** 关掉右键菜单（全局只留一个） */  function closeMenu(): void {
    const node = document.getElementById('vncp-menu')
    if (node && node.parentNode) node.parentNode.removeChild(node)
  }

  function onMenuGuard(event: Event): void {
    const node = document.getElementById('vncp-menu')
    if (!node) return
    const target = event.target as Node | null
    if (target && node.contains(target)) return
    closeMenu()
  }

  /** 全局监听只绑一次：点别处 / 滚轮 / 缩放 / Esc 都收起菜单 */
  function bindMenuGuards(): void {
    if (host.__VNCP_MENU_BOUND__) return
    host.__VNCP_MENU_BOUND__ = true
    document.addEventListener('mousedown', onMenuGuard, true)
    document.addEventListener(
      'keydown',
      function (event: KeyboardEvent) {
        if (event.key === 'Escape') closeMenu()
      },
      true
    )
    // 只在滚动 / 点别处 / Esc 时收起：窗口 resize 不该把菜单吃掉（Vnite 里切标签页会触发 resize）
    window.addEventListener('scroll', closeMenu, true)
  }

  function openMenu(at: MouseEvent, items: Array<{ label: string; danger?: boolean; run: () => void }>): void {
    closeMenu()
    bindMenuGuards()
    const menu = el('div', 'vncp-menu')
    menu.id = 'vncp-menu'
    applyPanelTheme(menu)
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const btn = el('button', 'vncp-menu-item' + (item.danger ? ' vncp-danger' : ''), item.label)
      ;(btn as HTMLButtonElement).type = 'button'
      btn.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        closeMenu()
        item.run()
      })
      menu.appendChild(btn)
    }
    document.body.appendChild(menu)
    // 贴着鼠标出现，靠边时翻到另一侧，避免出屏
    const rect = menu.getBoundingClientRect()
    const left = Math.max(6, Math.min(at.clientX, window.innerWidth - rect.width - 8))
    const top = Math.max(6, Math.min(at.clientY, window.innerHeight - rect.height - 8))
    menu.style.left = left + 'px'
    menu.style.top = top + 'px'
  }

  /** 取 facts 里某一项的值（性别 / 生日 / 身高 / 体重 / 三围 / 血型） */
  function factValue(character: any, key: string): string {
    const facts = (character && character.facts) || []
    for (let i = 0; i < facts.length; i++) {
      if (String(facts[i] && facts[i].k) === key) return String((facts[i] && facts[i].v) || '')
    }
    return ''
  }

  function digitsOnly(value: string): string {
    return String(value || '').replace(/[^\d.]/g, '')
  }

  /** 右键 → 删除：只是把这个人从「本作名单」里隐藏（进 overrides，重新刮削也不会回来） */
  function removeCharacter(character: any): void {
    const gameId = routeGameId()
    const id = String((character && character.id) || '')
    const name = String((character && character.n) || '')
    if (!gameId) {
      setStatus('error', '❌ 没有拿到当前作品的 id（路由里没有 gameId），无法删除')
      return
    }
    if (!id) {
      setStatus('error', '❌ 这个角色没有可用的 id，无法删除')
      return
    }
    enqueue({ cmd: 'remove-char', gameId: gameId, id: id, name: name })
    setStatus('loading', '正在删除「' + name + '」…')
  }

  /** 右键 → 编辑：改完写进 overrides，主进程叠加后重新下发 */
  function openEditor(character: any): void {
    closeDetail()
    const gameId = routeGameId()
    const id = String((character && character.id) || '')
    if (!gameId || !id) {
      setStatus('error', '❌ 没拿到游戏 / 角色 id，无法编辑')
      return
    }
    const modal = el('div', 'vncp-modal')
    modal.id = 'vncp-modal'
    applyPanelTheme(modal)
    modal.style.fontFamily = window.getComputedStyle(document.getElementById('vncp-panel') || document.body).fontFamily
    modal.style.fontSize = window.getComputedStyle(document.getElementById('vncp-panel') || document.body).fontSize
    const dialog = el('div', 'vncp-dialog')

    const closeBtn = el('button', 'vncp-dialog-close', '×') as HTMLButtonElement
    closeBtn.type = 'button'
    closeBtn.title = '关闭'
    closeBtn.addEventListener('click', function () {
      closeDetail()
    })
    dialog.appendChild(closeBtn)

    dialog.appendChild(el('div', 'vncp-dialog-title', '编辑人物：' + String(character.n || '')))
    dialog.appendChild(
      el('div', 'vncp-dialog-sub', '改动只存在本地（缓存 + 个人修正），重新刮削不会覆盖；删掉的角色也不会再出现。')
    )

    const fields: Array<{ key: string; label: string; value: string; wide?: boolean; multiline?: boolean }> = [
      { key: 'name', label: '名字', value: String(character.n || '') },
      { key: 'originalName', label: '原名', value: String(character.o || '') },
      { key: 'nameAlt', label: '译名', value: String(character.alt || '') },
      { key: 'roleLabel', label: '定位（主角 / 配角…）', value: String(character.role || '') },
      { key: 'cv', label: 'CV', value: String(character.cv || '') },
      { key: 'gender', label: '性别', value: factValue(character, '性别') },
      { key: 'birthday', label: '生日', value: factValue(character, '生日') },
      { key: 'heightCm', label: '身高（cm）', value: digitsOnly(factValue(character, '身高')) },
      { key: 'weightKg', label: '体重（kg）', value: digitsOnly(factValue(character, '体重')) },
      { key: 'bloodType', label: '血型', value: factValue(character, '血型') },
      { key: 'measurements', label: '三围（86/57/82，可带罩杯）', value: factValue(character, '三围') },
      { key: 'aliases', label: '别名（逗号或顿号分隔）', value: (character.aliases || []).join('、'), wide: true },
      {
        key: 'intro',
        label: '简介',
        value: String(character.about || character.intro || ''),
        wide: true,
        multiline: true
      }
    ]

    const form = el('form', 'vncp-form') as HTMLFormElement
    const inputs: Record<string, HTMLInputElement | HTMLTextAreaElement> = {}
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]
      const wrap = el('div', 'vncp-field' + (field.wide ? ' vncp-wide' : ''))
      wrap.appendChild(el('span', undefined, field.label))
      const input = field.multiline
        ? (document.createElement('textarea') as HTMLTextAreaElement)
        : (document.createElement('input') as HTMLInputElement)
      if (!field.multiline) (input as HTMLInputElement).type = 'text'
      input.value = field.value
      wrap.appendChild(input)
      inputs[field.key] = input
      form.appendChild(wrap)
    }

    const actions = el('div', 'vncp-form-actions')
    const del = el('button', 'vncp-btn', '删除此人') as HTMLButtonElement
    del.type = 'button'
    del.style.marginRight = 'auto'
    del.addEventListener('click', function () {
      closeDetail()
      removeCharacter(character)
    })
    const cancel = el('button', 'vncp-btn', '取消') as HTMLButtonElement
    cancel.type = 'button'
    cancel.addEventListener('click', function () {
      closeDetail()
    })
    const save = el('button', 'vncp-btn vncp-btn-primary', '保存') as HTMLButtonElement
    save.type = 'submit'
    actions.appendChild(del)
    actions.appendChild(cancel)
    actions.appendChild(save)
    form.appendChild(actions)

    form.addEventListener('submit', function (event) {
      event.preventDefault()
      const patch: Record<string, string> = {}
      Object.keys(inputs).forEach(function (key) {
        patch[key] = String(inputs[key].value || '').trim()
      })
      enqueue({ cmd: 'edit-char', gameId: gameId, id: id, patch: patch })
      setStatus('loading', '正在保存「' + (patch.name || String(character.n || '')) + '」…')
      closeDetail()
    })

    dialog.appendChild(form)
    modal.appendChild(dialog)
    document.body.appendChild(modal)
    document.addEventListener(
      'keydown',
      function (event: KeyboardEvent) {
        if (event.key === 'Escape') closeDetail()
      },
      true
    )
  }

  /** 渲染进程 → 主进程的 request/response（preload 暴露的 ipcRenderer.invoke） */
  function bridgeInvoke(channel: string, payload?: any): Promise<any> {
    try {
      const bridge = (window as any).electron
      const ipc = bridge && bridge.ipcRenderer
      if (!ipc || typeof ipc.invoke !== 'function') return Promise.resolve(null)
      return Promise.resolve(ipc.invoke(channel, payload)).catch(function (error: any) {
        void error
        return null
      })
    } catch (error) {
      void error
      return Promise.resolve(null)
    }
  }

  function currentWorkName(): string {
    try {
      const data = host.__VNCP_DATA__ || null
      const game = data ? currentGame(data) : null
      return game ? String(game.workName || '') : ''
    } catch (error) {
      void error
      return ''
    }
  }

  function roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number
  ): void {
    const radius = Math.min(r, w / 2, h / 2)
    ctx.beginPath()
    ctx.moveTo(x + radius, y)
    ctx.lineTo(x + w - radius, y)
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius)
    ctx.lineTo(x + w, y + h - radius)
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h)
    ctx.lineTo(x + radius, y + h)
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius)
    ctx.lineTo(x, y + radius)
    ctx.quadraticCurveTo(x, y, x + radius, y)
    ctx.closePath()
  }

  function drawCover(
    ctx: CanvasRenderingContext2D,
    img: HTMLImageElement,
    x: number,
    y: number,
    w: number,
    h: number
  ): void {
    const iw = img.width || w
    const ih = img.height || h
    const scale = Math.max(w / iw, h / ih)
    const dw = iw * scale
    const dh = ih * scale
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh)
  }

  function clipText(ctx: CanvasRenderingContext2D, value: string, maxWidth: number): string {
    if (ctx.measureText(value).width <= maxWidth) return value
    let text = value
    while (text.length > 1 && ctx.measureText(text + '…').width > maxWidth) {
      text = text.slice(0, -1)
    }
    return text + '…'
  }

  function wrapText(ctx: CanvasRenderingContext2D, value: string, maxWidth: number): string[] {
    const out: string[] = []
    let line = ''
    for (let i = 0; i < value.length; i++) {
      const next = line + value.charAt(i)
      if (line && ctx.measureText(next).width > maxWidth) {
        out.push(line)
        line = value.charAt(i)
      } else {
        line = next
      }
    }
    if (line) out.push(line)
    return out
  }

  function loadImage(src: string): Promise<HTMLImageElement | null> {
    return new Promise(function (resolve) {
      const img = new Image()
      img.onload = function () {
        resolve(img)
      }
      img.onerror = function () {
        resolve(null)
      }
      img.src = src
    })
  }

  /**
   * 人物卡出图：在渲染进程用 canvas 画好（中文排版、圆角、裁切都由浏览器负责），
   * 再把 dataURL 交给主进程落盘 —— 不依赖任何截图/栅格化库，也不吃屏幕分辨率。
   */
  /**
   * 人物卡出图：宽 900，高度按内容自适应（不少于 1260）。
   * 特征区块跟着弹窗里「显示剧透」的状态走：点开了就连剧透标签一起画，没点就只画无剧透的。
   */
  async function saveCardImage(character: any, btn?: HTMLButtonElement): Promise<void> {
    const label = btn ? btn.textContent : ''
    if (btn) {
      btn.disabled = true
      btn.textContent = '正在出图…'
    }
    try {
      const W = 900
      const pad = 60
      const dark = isDark()
      const fg = dark ? '#e9ebf2' : '#1d2027'
      const dim = dark ? '#9aa3b4' : '#5d6472'
      const accent = '#8fa2ff'
      const bg1 = dark ? '#191b21' : '#f6f7fb'
      const bg2 = dark ? '#101116' : '#e8eaf2'
      const chipBg = dark ? 'rgba(255,255,255,.06)' : 'rgba(20,24,40,.05)'
      const chipSpoilBg = dark ? 'rgba(143,162,255,.14)' : 'rgba(80,100,220,.09)'
      const chipLine = dark ? 'rgba(255,255,255,.14)' : 'rgba(20,24,40,.16)'
      const font = function (size: number, weight?: string): string {
        return (weight || '400') + ' ' + size + 'px "Microsoft YaHei","PingFang SC",system-ui,sans-serif'
      }

      // 头像：优先用本地 data URI；远程图先让主进程缩一张回来，避免 canvas 被跨域污染
      const avatarSrc = String(character.img || '')
      const remote = String(character.src || avatarSrc)
      let uri = avatarSrc
      if (remote && remote.indexOf('data:') !== 0) {
        const got = await bridgeInvoke('character-atlas:image', { url: remote })
        if (typeof got === 'string' && got.indexOf('data:') === 0) uri = got
      }
      const avatar = uri && uri.indexOf('data:') === 0 ? await loadImage(uri) : null

      // 特征：弹窗里点过「显示剧透」就连剧透一起导出，没点就只导无剧透的
      const toggleEl = document.querySelector('#vncp-modal .vncp-trait-toggle') as HTMLElement | null
      const spoilerOpen = !!toggleEl && toggleEl.getAttribute('data-open') === '1'
      const traitGroups: Array<{ g: string; items: any[] }> = []
      const rawTraits = (character.traits || []) as any[]
      for (let i = 0; i < rawTraits.length; i++) {
        const item = rawTraits[i]
        if (!item || !item.n) continue
        if (item.sp && !spoilerOpen) continue
        const group = String(item.g || '其他')
        let bucket: { g: string; items: any[] } | null = null
        for (let k = 0; k < traitGroups.length; k++) {
          if (traitGroups[k].g === group) bucket = traitGroups[k]
        }
        if (!bucket) {
          bucket = { g: group, items: [] }
          traitGroups.push(bucket)
        }
        bucket.items.push(item)
      }
      let traitCount = 0
      for (let i = 0; i < traitGroups.length; i++) traitCount += traitGroups[i].items.length

      const facts = (character.facts || []) as Array<{ k: string; v: string }>
      const about = String(character.about || character.intro || '')
        .replace(/\s+/g, ' ')
        .trim()
      const work = currentWorkName()
      const chipFont = font(21, '500')

      /** 画（或只量）特征区块，返回这一块结束时的 y */
      const paintTraits = function (c: CanvasRenderingContext2D, top: number): number {
        let cursor = top
        for (let gi = 0; gi < traitGroups.length; gi++) {
          const group = traitGroups[gi]
          c.font = font(21)
          const indent = pad + c.measureText(group.g).width + 16
          let x = indent
          let rowTop = cursor
          c.fillStyle = dim
          c.fillText(group.g, pad, rowTop + 33)
          for (let j = 0; j < group.items.length; j++) {
            const item = group.items[j]
            const text = String(item.n) + (item.s ? '·性' : '')
            c.font = chipFont
            const width = Math.ceil(c.measureText(text).width) + 26
            if (j > 0 && x + width > W - pad) {
              rowTop += 46
              x = indent
            }
            roundRect(c, x, rowTop + 8, width, 38, 19)
            c.fillStyle = item.sp ? chipSpoilBg : chipBg
            c.fill()
            c.strokeStyle = item.sp ? accent : chipLine
            c.lineWidth = 1
            c.stroke()
            c.fillStyle = item.sp ? accent : fg
            c.fillText(text, x + 13, rowTop + 34)
            x += width + 8
          }
          cursor = rowTop + 66
        }
        return cursor
      }

      // 先量一遍：特征折行几行、简介折行几行，据此决定图片高度（简介不再被截断）
      const measure = document.createElement('canvas').getContext('2d')
      if (!measure) throw new Error('拿不到 2D 画布')
      const baseY = 70 + 400 + 56
      const factsRows = facts.length ? Math.ceil(facts.length / 2) * 40 : 0
      const factsBlock = facts.length ? 40 + factsRows + 26 : 0
      const traitsTop = baseY + factsBlock + (traitGroups.length ? 40 : 0)
      const traitsBottom = traitGroups.length ? paintTraits(measure, traitsTop) + 10 : traitsTop
      measure.font = font(21)
      const introLines = about ? wrapText(measure, about, W - pad * 2) : []
      const introBlock = introLines.length ? 40 + introLines.length * 36 : 0
      const H = Math.max(880, Math.round(traitsBottom + introBlock + 150))

      const canvas = document.createElement('canvas')
      canvas.width = W
      canvas.height = H
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('拿不到 2D 画布')

      const grad = ctx.createLinearGradient(0, 0, W, H)
      grad.addColorStop(0, bg1)
      grad.addColorStop(1, bg2)
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, W, H)
      ctx.fillStyle = accent
      ctx.fillRect(0, 0, W, 4)

      const avaW = 300
      const avaH = 400
      const avaX = pad
      const avaY = 70
      roundRect(ctx, avaX, avaY, avaW, avaH, 18)
      ctx.save()
      ctx.clip()
      if (avatar) {
        drawCover(ctx, avatar, avaX, avaY, avaW, avaH)
      } else {
        ctx.fillStyle = dark ? '#232631' : '#d8dceb'
        ctx.fillRect(avaX, avaY, avaW, avaH)
        ctx.fillStyle = dim
        ctx.font = font(120, '500')
        ctx.textAlign = 'center'
        ctx.fillText(String(character.n || '?').slice(0, 1), avaX + avaW / 2, avaY + avaH / 2 + 42)
        ctx.textAlign = 'left'
      }
      ctx.restore()

      const textX = avaX + avaW + 44
      let y = avaY + 48
      ctx.fillStyle = fg
      ctx.font = font(46, '600')
      ctx.fillText(clipText(ctx, String(character.n || ''), W - textX - pad), textX, y)
      y += 46
      const alt = String(character.alt || '')
      if (alt && alt !== String(character.n || '')) {
        ctx.fillStyle = dim
        ctx.font = font(24)
        ctx.fillText(clipText(ctx, alt, W - textX - pad), textX, y)
        y += 40
      }
      const info: string[] = []
      if (character.role) info.push(String(character.role))
      if (character.cv) info.push('CV · ' + String(character.cv))
      if (character.meta) info.push(String(character.meta))
      ctx.font = font(22)
      for (let i = 0; i < info.length; i++) {
        ctx.fillStyle = dim
        ctx.fillText(clipText(ctx, info[i], W - textX - pad), textX, y)
        y += 34
      }

      let cy = baseY
      if (facts.length) {
        ctx.fillStyle = accent
        ctx.font = font(22, '500')
        ctx.fillText('资料', pad, cy)
        cy += 40
        const colW = Math.floor((W - pad * 2) / 2)
        for (let i = 0; i < facts.length; i++) {
          const col = i % 2
          const row = Math.floor(i / 2)
          const fx = pad + col * colW
          const fy = cy + row * 40
          ctx.fillStyle = dim
          ctx.font = font(21)
          ctx.fillText(clipText(ctx, String(facts[i].k), 170), fx, fy)
          ctx.fillStyle = fg
          ctx.font = font(21, '500')
          ctx.fillText(clipText(ctx, String(facts[i].v), colW - 190), fx + 160, fy)
        }
        cy += factsRows + 26
      }

      if (traitGroups.length) {
        ctx.fillStyle = accent
        ctx.font = font(22, '500')
        ctx.fillText('特征（' + traitCount + '）' + (spoilerOpen ? ' · 含剧透' : ''), pad, cy)
        cy += 40
        cy = paintTraits(ctx, cy) + 10
      }

      if (introLines.length) {
        ctx.fillStyle = accent
        ctx.font = font(22, '500')
        ctx.fillText('简介', pad, cy)
        cy += 40
        ctx.fillStyle = fg
        ctx.font = font(21)
        for (let i = 0; i < introLines.length; i++) {
          ctx.fillText(introLines[i], pad, cy)
          cy += 36
        }
      }

      ctx.fillStyle = dim
      ctx.font = font(19)
      ctx.fillText('Character Atlas · 人物图鉴' + (work ? ' · ' + work : ''), pad, H - 40)
      ctx.textAlign = 'right'
      ctx.fillStyle = accent
      ctx.font = font(18)
      ctx.fillText(new Date().toLocaleDateString('zh-CN'), W - pad, H - 40)
      ctx.textAlign = 'left'

      const dataUrl = canvas.toDataURL('image/png')
      const safeName = String(character.n || 'character').replace(/[\\/:*?"<>|]/g, '_')
      const saved = await bridgeInvoke('character-atlas:save-image', {
        name: safeName + '.png',
        dataUrl: dataUrl
      })
      if (saved && saved.ok) setStatus('ok', '✅ 已保存人物卡：' + String(saved.path || ''))
      else if (saved && saved.canceled) setStatus('ok', '已取消出图')
      else setStatus('error', '❌ 出图失败：' + String((saved && saved.error) || '主进程没响应'))
    } catch (error) {
      setStatus('error', '❌ 出图失败：' + (error instanceof Error ? error.message : String(error)))
    } finally {
      if (btn) {
        btn.disabled = false
        btn.textContent = label || '保存成图片'
      }
    }
  }

  /** 右键 → 换成本地图片（复制进缓存目录并写入个人修正层） */
  function replaceImage(character: any): void {
    const gameId = routeGameId()
    const id = String((character && character.id) || '')
    if (!gameId || !id) {
      setStatus('error', '❌ 没拿到游戏 / 角色 id，换图失败')
      return
    }
    setStatus('loading', '正在选择本地图片…')
    void bridgeInvoke('character-atlas:pick-image', {})
      .then(function (picked: any) {
        if (!picked || !picked.ok) {
          if (picked && picked.canceled) setStatus('ok', '已取消换图')
          else setStatus('error', '❌ ' + String((picked && picked.error) || '打不开文件对话框'))
          return null
        }
        return bridgeInvoke('character-atlas:set-image', {
          gameId: gameId,
          charId: id,
          filePath: String(picked.path || '')
        }).then(function (res: any) {
          if (res && res.ok) setStatus('ok', '✅ 已换图：' + String(character.n || ''))
          else setStatus('error', '❌ 换图失败：' + String((res && res.error) || '主进程没响应'))
          return null
        })
      })
      .catch(function (error: any) {
        setStatus('error', '❌ 换图失败：' + String(error instanceof Error ? error.message : error))
      })
  }

  /** 弹窗里的「登场作品」：先占位，再向主进程要 /appearances 的结果 */
  let appearSeq = 0
  function appendAppearances(dialog: HTMLElement, character: any): void {
    const id = String(character.id || '')
    if (!id) return
    const section = el('div', 'vncp-section')
    section.appendChild(el('div', 'vncp-section-title', '登场作品'))
    const box = el('div', 'vncp-appear')
    box.appendChild(el('div', 'vncp-note', '正在读取…'))
    section.appendChild(box)
    dialog.appendChild(section)

    const seq = ++appearSeq
    void bridgeInvoke('character-atlas:appearances', { charId: id }).then(function (res: any) {
      if (seq !== appearSeq) return
      while (box.firstChild) box.removeChild(box.firstChild)
      const items = (res && res.items) || []
      if (!items.length) {
        box.appendChild(
          el('div', 'vncp-note', res && res.error ? '读取失败：' + String(res.error) : '没有可显示的登场作品')
        )
        return
      }
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const row = el('button', 'vncp-appear-row', '') as HTMLButtonElement
        row.type = 'button'
        row.setAttribute('data-link', item.url ? '1' : '0')
        row.appendChild(el('span', '', String(item.title || '')))
        if (item.role) row.appendChild(el('span', 'vncp-appear-role', String(item.role)))
        if (item.url) {
          row.title = '在浏览器里打开这部作品（KunGalgame）'
          row.addEventListener('click', function (event) {
            event.preventDefault()
            event.stopPropagation()
            openExternal(String(item.url))
          })
        } else {
          row.title = String(item.title || '')
        }
        box.appendChild(row)
      }
    })
  }

  /** 缓存统计：作品数 / 人物数 / 图片体积 / 最早最近缓存，可清理过期条目 */
  function openStats(): void {
    closeDetail()
    const modal = el('div', 'vncp-modal')
    modal.id = 'vncp-modal'
    applyPanelTheme(modal)
    const dialog = el('div', 'vncp-dialog')

    const closeBtn = el('button', 'vncp-dialog-close', '×') as HTMLButtonElement
    closeBtn.type = 'button'
    closeBtn.title = '关闭'
    closeBtn.addEventListener('click', function () {
      closeDetail()
    })
    dialog.appendChild(closeBtn)
    dialog.appendChild(el('div', 'vncp-dialog-title', '缓存统计'))
    dialog.appendChild(el('div', 'vncp-dialog-sub', '只读本地数据库与图片目录，不联网。'))

    const box = el('div', 'vncp-stats')
    dialog.appendChild(box)
    const actions = el('div', 'vncp-dialog-actions')
    const prune = el('button', 'vncp-act', '清理过期缓存') as HTMLButtonElement
    prune.type = 'button'
    prune.title = '删掉超过「缓存有效期」的人物数据（图片保留）'
    const openDir = el('button', 'vncp-act', '打开缓存目录') as HTMLButtonElement
    openDir.type = 'button'
    openDir.title = '在文件管理器里打开图片缓存目录'
    openDir.addEventListener('click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      enqueue({ cmd: 'open-dir' })
    })
    actions.appendChild(prune)
    actions.appendChild(openDir)
    dialog.appendChild(actions)

    modal.appendChild(dialog)
    modal.addEventListener('click', function (event) {
      if (event.target === modal) closeDetail()
    })
    document.body.appendChild(modal)

    const paint = function (data: any): void {
      while (box.firstChild) box.removeChild(box.firstChild)
      if (!data || data.error) {
        box.appendChild(el('b', '', '读取失败'))
        box.appendChild(el('span', '', String((data && data.error) || '主进程没响应')))
        return
      }
      const rows: Array<[string, string]> = [
        ['已缓存作品', String(data.games || 0) + ' 部'],
        ['人物总数', String(data.characters || 0) + ' 人'],
        ['图片文件', String(data.images || 0) + ' 个 · ' + String(data.imageSize || '0 B')],
        ['缓存目录', String(data.dir || '—')],
        ['最早缓存', String(data.oldest || '—')],
        ['最近缓存', String(data.newest || '—')],
        ['有效期', String(data.ttlHours || 0) + ' 小时（过期后打开会重新刮）']
      ]
      for (let i = 0; i < rows.length; i++) {
        box.appendChild(el('b', '', rows[i][0]))
        box.appendChild(el('span', '', rows[i][1]))
      }
    }
    void bridgeInvoke('character-atlas:stats', {}).then(paint)

    prune.addEventListener('click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      if (!window.confirm('清理所有已过期的人物数据缓存？图片不会被删除。')) return
      prune.disabled = true
      prune.textContent = '清理中…'
      void bridgeInvoke('character-atlas:prune-cache', {}).then(function (res: any) {
        prune.disabled = false
        prune.textContent = '清理过期缓存'
        if (res && res.ok) setStatus('ok', '✅ 已清理 ' + String(res.removed || 0) + ' 部作品的过期缓存')
        else setStatus('error', '❌ 清理失败：' + String((res && res.error) || '主进程没响应'))
        void bridgeInvoke('character-atlas:stats', {}).then(paint)
      })
    })
  }

  // ---------- 快捷键 ----------
  /**
   * 列表页只保留 `/`（聚焦搜索）与 Esc（关右键菜单）。
   * 方向键 / Enter 不再抢：卡片是给人用鼠标点的，键盘留给详情弹窗（←→ 换人、E 编辑、S 出图、T 剧透）。
   */
  function attachKeys(): void {
    if (host.__VNCP_KEYS__) return
    host.__VNCP_KEYS__ = true
    document.addEventListener(
      'keydown',
      function (event: KeyboardEvent) {
        const target = event.target as HTMLElement | null
        const typing =
          !!target &&
          (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

        if (event.key === 'Escape') {
          if (document.getElementById('vncp-menu')) {
            event.preventDefault()
            closeMenu()
          }
          return
        }
        // 弹窗开着时，键盘整个让给弹窗自己的快捷键
        if (document.getElementById('vncp-modal')) return
        if (typing) return

        if (event.key === '/') {
          const box = document.querySelector('#vncp-panel .vncp-search') as HTMLInputElement | null
          if (!box) return
          event.preventDefault()
          box.focus()
          box.select()
        }
      },
      true
    )
  }

  function buildCard(character: any, workName?: string): HTMLElement {
    const card = el('div', 'vncp-card')
    const avatar = el('div', 'vncp-ava')
    if (character.img) {
      const img = document.createElement('img')
      img.src = String(character.img)
      img.alt = String(character.n || '')
      img.loading = 'lazy'
      img.referrerPolicy = 'no-referrer'
      avatar.appendChild(img)
    } else {
      avatar.textContent = String(character.n || '?').slice(0, 1)
    }
    card.appendChild(avatar)

    const body = el('div', 'vncp-body')
    const row = el('div', 'vncp-row')
    row.appendChild(el('span', 'vncp-name', String(character.n || '')))
    if (character.role) row.appendChild(el('span', 'vncp-role', String(character.role)))
    body.appendChild(row)
    // 全局搜索结果里要能看出这个角色出自哪部作品
    if (workName) body.appendChild(el('div', 'vncp-cardwork', String(workName)))

    const cardAlt = String(character.alt || '')
    if (cardAlt && cardAlt !== String(character.n || '')) {
      body.appendChild(el('div', 'vncp-sub', cardAlt))
    }
    if (character.cv) {
      const cvLine = el('div', 'vncp-sub')
      cvLine.appendChild(el('span', undefined, text('cv') + ' · '))
      const cvHit = el('span', 'vncp-cv-hit', String(character.cv))
      cvHit.title = '在所有作品里搜这位声优的角色'
      cvHit.addEventListener('click', function (event: MouseEvent) {
        event.preventDefault()
        event.stopPropagation()
        setSearch(String(character.cv))
      })
      cvLine.appendChild(cvHit)
      body.appendChild(cvLine)
    }
    if (character.meta) body.appendChild(el('div', 'vncp-sub', String(character.meta)))
    if (character.intro) body.appendChild(el('div', 'vncp-intro', String(character.intro)))

    // 卡片上只做展示：筛选入口统一放在详情弹窗里（点开卡片才能点标签）
    const traits = ((character.traits || []) as any[]).filter(function (item) {
      return item && item.n && !item.s && !item.sp
    })
    if (traits.length) {
      const chips = el('div', 'vncp-chips')
      const limit = Math.min(traits.length, 8)
      for (let i = 0; i < limit; i++) {
        chips.appendChild(el('span', 'vncp-chip', String(traits[i].n)))
      }
      body.appendChild(chips)
    } else if (character.chips && character.chips.length) {
      const chips = el('div', 'vncp-chips')
      for (let i = 0; i < character.chips.length; i++) {
        chips.appendChild(el('span', 'vncp-chip', String(character.chips[i])))
      }
      body.appendChild(chips)
    }

    card.appendChild(body)
    card.title = '左键查看完整资料 · 右键可编辑 / 删除'
    card.addEventListener('click', function () {
      openDetail(character)
    })
    card.addEventListener('contextmenu', function (event: MouseEvent) {
      event.preventDefault()
      event.stopPropagation()
      openMenu(event, [
        { label: '编辑这个人的资料…', run: function () { openEditor(character) } },
        { label: '换成本地图片…', run: function () { replaceImage(character) } },
        { label: '保存人物卡图片…', run: function () { void saveCardImage(character) } },
        { label: '从本作人物栏删除', danger: true, run: function () { removeCharacter(character) } }
      ])
    })
    return card
  }

  function renderEmpty(
    panel: HTMLElement,
    lines: string[],
    diagnostic?: string,
    actionTitle?: string
  ): void {
    const box = el('div', 'vncp-empty')
    for (let i = 0; i < lines.length; i++) {
      box.appendChild(el('div', undefined, lines[i]))
    }
    // 只要调用方给了 actionTitle（哪怕是空串），就必须有一个手动入口；
    // 之前空串被当成「不要按钮」，详情页结构一变就彻底没有自救路径了
    if (actionTitle !== undefined) box.appendChild(scrapeButton(actionTitle))
    panel.appendChild(box)
    if (diagnostic) panel.appendChild(el('div', 'vncp-diag', diagnostic))
  }

  /** 空态/失败态里的手动入口：面板永远留一条自救路径 */
  function scrapeButton(title: string): HTMLElement {
    const label = text('start')
    const btn = el('button', 'vncp-btn', label) as HTMLButtonElement
    btn.type = 'button'
    btn.style.marginTop = '10px'
    btn.addEventListener('click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      btn.disabled = true
      btn.textContent = text('loading')
      setStatus('loading', '⏳ 已提交刮削请求，等待主进程…')
      const candidates = requestScrape(title)
      setStatus(
        'loading',
        candidates.length
          ? '⏳ 正在刮削：' + candidates[0] + '（候选 ' + candidates.length + ' 个）'
          : '⏳ 正在刮削（未读到作品名，主进程将回落到最近启动的游戏）'
      )
      window.setTimeout(function () {
        if (btn.disabled) {
          btn.disabled = false
          btn.textContent = label
        }
      }, 120000)
    })
    return btn
  }

  /**
   * 页面对应的作品标识。Vnite 切游戏时 **不会** 让快照版本号变化，
   * 旧实现只比 `data.v`，所以切到别的游戏还在显示上一部的人物 —— 这里把
   * 「当前页面匹配到哪部作品」也算进 key。
   */
  function pageKey(data: Record<string, any> | null): string {
    const game = currentGame(data as any)
    const id = game ? String(game.id || game.workName || '') : ''
    return String((data && data.v) || 0) + '|' + id
  }

  let keyCheckedAt = 0

  function refreshIfStale(): void {
    const now = Date.now()
    if (now - keyCheckedAt < 500) return
    keyCheckedAt = now
    const panel = panelEl()
    if (!panel) return
    const data = host.__VNCP_DATA__ || null
    const key = pageKey(data)
    if (host.__VNCP_KEY__ === key && panel.firstChild) return
    host.__VNCP_KEY__ = key
    render()
  }

  function render(): void {
    const panel = panelEl()
    if (!panel) return
    try {
      renderInner(panel)
    } catch (error) {
      // 出错时把原因写进面板本身 —— Vnite 不转发 console，只能靠界面回传
      while (panel.firstChild) panel.removeChild(panel.firstChild)
      const message = error instanceof Error ? error.message : String(error)
      renderEmpty(panel, [text('failed')], '渲染异常：' + message)
    }
  }

  function renderInner(panel: HTMLElement): void {
    const data = host.__VNCP_DATA__ || null
    panel.setAttribute('data-theme', isDark() ? 'dark' : 'light')
    panel.setAttribute('data-v', String((data && data.v) || 0))
    // 记下这次画的是「哪部作品 + 哪版数据」，tick 靠它判断需不需要重画
    host.__VNCP_KEY__ = pageKey(data)
    applyFont(panel)
    attachKeys()
    // 再保险一次：只允许存在一个我们自己画的面板
    const leftovers = stalePanels()
    for (let i = 0; i < leftovers.length; i++) {
      const node = leftovers[i]
      if (node === panel) continue
      if (node.parentElement) node.parentElement.removeChild(node)
    }
    while (panel.firstChild) panel.removeChild(panel.firstChild)

    // 刮削/刷新的实时状态（成功失败都写清楚，不要再「点了没反应」）
    const status = host.__VNCP_STATUS__ || null
    if (status && status.text) {
      const bar = el('div', undefined, String(status.text))
      bar.className = 'vncp-status'
      bar.setAttribute('data-kind', String(status.kind || 'loading'))
      panel.appendChild(bar)
    }

    if (!data || !data.games || !data.games.length) {
      const title = guessTitle()
      renderEmpty(panel, [text('empty'), text('hint')], undefined, title)
      // 每部作品只自动问一次「有没有缓存」，避免反复重绘
      const autoKey = 'auto:' + (routeGameId() || title || '?')
      if (title && host.__VNCP_AUTO__ !== autoKey) {
        host.__VNCP_AUTO__ = autoKey
        setStatus('loading', '⏳ 正在读取本地缓存：' + title)
        requestData(title)
      }
      return
    }

    // 搜索模式：跨所有已缓存作品，不受当前页面是哪部游戏影响
    const query = searchOf().trim()
    if (query) {
      const games = (data.games || []) as any[]
      const hits: any[] = []
      const works: string[] = []
      for (let i = 0; i < games.length; i++) {
        const pool = (games[i].characters || []) as any[]
        for (let j = 0; j < pool.length; j++) {
          if (!matchesSearch(pool[j], query)) continue
          hits.push({ character: pool[j], work: String(games[i].workName || '') })
          const label = String(games[i].workName || '')
          if (label && works.indexOf(label) < 0) works.push(label)
        }
      }
      const head = el('div', 'vncp-head')
      head.appendChild(el('div', 'vncp-title', '搜索：' + query))
      head.appendChild(el('div', 'vncp-stat', hits.length + ' 人 · ' + works.length + ' 部作品'))
      head.appendChild(el('div', 'vncp-spacer'))
      head.appendChild(searchInput(query))
      panel.appendChild(head)
      if (!hits.length) {
        renderEmpty(panel, ['没有匹配「' + query + '」的角色（已搜索 ' + games.length + ' 部已缓存作品）'])
        return
      }
      const grid = el('div', 'vncp-grid')
      for (let i = 0; i < hits.length; i++) grid.appendChild(buildCard(hits[i].character, hits[i].work))
      panel.appendChild(grid)
      panel.appendChild(el('div', 'vncp-note', '搜索范围：所有已缓存作品（' + games.length + ' 部）'))
      return
    }

    const game = currentGame(data)
    // 换了作品就清掉上一条状态（否则会把 A 游戏的「已更新…」带到 B 游戏页）
    const gameKey = game ? String(game.id || game.workName || '') : ''
    if (host.__VNCP_LAST_GAME__ !== gameKey) {
      host.__VNCP_LAST_GAME__ = gameKey
      const tools = document.getElementById('vncp-settings-tools')
    if (tools && tools.parentElement) tools.parentElement.removeChild(tools)
    delete host.__VNCP_STATUS__
    }
    if (!game) {
      const title = guessTitle()
      const routeId = routeGameId()
      // 路由明确指向「这部作品」，但缓存里还没有它 → 这是「还没刮过」，不是「匹配失败」
      const lines = routeId ? [text('empty'), text('hint')] : [text('failed'), text('hint')]
      renderEmpty(
        panel,
        lines,
        text('diag', { title: title || (routeId ? 'gameId=' + routeId : '(未知)'), count: (data.games || []).length }),
        title
      )
      if (title) requestData(title)
      return
    }

    const head = el('div', 'vncp-head')
    head.appendChild(el('div', 'vncp-title', String(game.workName || (game.names || [])[0] || '')))
    if (game.source === 'vndb') {
      head.appendChild(el('span', 'vncp-src', 'VNDB'))
    } else if (game.workId) {
      // 同名系列作品（如 #886 / #1626 共用一批角色）靠这枚徽章就能确认刮的是哪一部
      head.appendChild(el('span', 'vncp-src', `KunGalgame #${String(game.workId)}`))
    }
    head.appendChild(
      el(
        'div',
        'vncp-stat',
        text('stat', {
          total: game.total || (game.characters || []).length,
          enriched: game.enriched || 0
        })
      )
    )
    head.appendChild(el('div', 'vncp-spacer'))
    head.appendChild(searchInput(''))

    const refresh = el('button', 'vncp-btn', text('refresh')) as HTMLButtonElement
    refresh.type = 'button'
    refresh.addEventListener('click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      refresh.disabled = true
      refresh.textContent = text('loading')
      // 走 IPC/队列通道（console marker 在 Vnite 里不一定送达主进程）
      enqueue({ cmd: 'refresh', gameId: String(game.id || '') })
      window.setTimeout(function () {
        refresh.disabled = false
        refresh.textContent = text('refresh')
      }, 8000)
    })
    head.appendChild(refresh)
    // 导出/导入/清空全部/打开目录都在「插件设置页」里（见 injectSettingsTools），
    // 面板上只保留一个针对当前作品的清空
    const clearOne = el('button', 'vncp-btn vncp-btn-ghost', '清空本作') as HTMLButtonElement
    clearOne.type = 'button'
    clearOne.title = '清空当前作品的人物缓存'
    clearOne.addEventListener('click', function (event) {
      event.preventDefault()
      event.stopPropagation()
      if (!window.confirm('清空当前作品的人物缓存？')) return
      setStatus('loading', '⏳ 已提交：清空当前作品')
      enqueue({ cmd: 'clear-one', gameId: String(game.id || '') })
    })
    head.appendChild(clearOne)
    panel.appendChild(head)

    const allCharacters = (game.characters || []) as any[]
    const filter = filterOf()
    const characters = filter
      ? allCharacters.filter(function (item) {
          return matchFilter(item, filter)
        })
      : allCharacters
    if (filter) {
      const bar = el('div', 'vncp-filterbar')
      bar.appendChild(el('span', 'vncp-filterlabel', '筛选：' + filter.label))
      bar.appendChild(
        el('span', 'vncp-filtercount', characters.length + ' / ' + allCharacters.length + ' 人')
      )
      const clear = el('button', 'vncp-chip vncp-chip-clear', '✕ 清除筛选') as HTMLButtonElement
      clear.type = 'button'
      clear.addEventListener('click', function (event) {
        event.preventDefault()
        setFilter(null)
      })
      bar.appendChild(clear)
      panel.appendChild(bar)
    }
    if (!characters.length) {
      const gameTitle = String(game.workName || (game.names || [])[0] || '')
      renderEmpty(panel, [text('need')], undefined, gameTitle)
      if (gameTitle) requestData(gameTitle)
      return
    }

    if (!characters.length && filter) {
      renderEmpty(panel, ['没有符合「' + filter.label + '」的角色'])
      return
    }
    const grid = el('div', 'vncp-grid')
    for (let i = 0; i < characters.length; i++) grid.appendChild(buildCard(characters[i]))
    panel.appendChild(grid)

    if (game.truncated) panel.appendChild(el('div', 'vncp-note', text('truncated')))
    panel.appendChild(el('div', 'vncp-note', text('source')))
    // 常驻诊断行：报问题时看一眼截图就知道「读到了什么标题 / 命中了哪部作品」
    panel.appendChild(
      el(
        'div',
        'vncp-diagline',
        '页面：' +
          (guessTitle() || '(未读到)') +
          ' · 命中：' +
          String(game.workName || game.id || '?') +
          ' · 快照：' +
          String((data && data.games ? data.games.length : 0) || 0) +
          ' 部'
      )
    )
  }

  // ────────────────────────── 「更新游戏元数据」对话框 ──────────────────────────

  /** 插件设置页（#/plugin）里属于本插件的那张卡片 */
  /**
   * 点开插件设置后，Vnite 会弹出一个配置面板（包含 API Key / 语言 / 深度刮削人数 等控件）。
   * 导出的四个按钮要塞进**这个面板**，而不是插件列表里的卡片（卡片里塞会挤成一行文字）。
   */
  /**
   * 配置项列表容器：工具条要当成**一个普通设置项**接在列表最后，
   * 这样它和 API Key / 缓存小时 那些行一样排在对话框里，不会盖住底部的取消/保存。
   */
  function settingsRows(): HTMLElement | null {
    const ROW_HINTS = [
      '缓存有效期（小时）',
      '缓存有效期',
      '缓存小时',
      '本地限流',
      '深度刮削人数',
      'API Key',
      'VNDB 兜底',
      '人物头像下载到本地',
      '导出时带上图片'
    ]
    const nodes = Array.prototype.slice.call(
      document.querySelectorAll('div,section,ul')
    ) as HTMLElement[]
    const hitsOf = function (text: string): number {
      let hits = 0
      for (let k = 0; k < ROW_HINTS.length; k++) {
        if (text.indexOf(ROW_HINTS[k]) >= 0) hits += 1
      }
      return hits
    }
    let best: HTMLElement | null = null
    let bestScore = 0
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      if (node.id === 'vncp-settings-tools' || node.closest('#vncp-settings-tools')) continue
      const hits = hitsOf(node.textContent || '')
      if (hits < 2) continue
      const kids = Array.prototype.slice.call(node.children) as HTMLElement[]
      if (kids.length < 2) continue
      // 真正的列表容器：**每个子元素各是一行**（各自命中至少一个标题）。
      // 光看文字命中会把外层对话框（标题 + 列表 + 底部按钮）也当成候选，
      // 那样工具条会被塞到对话框外面去。
      let rowLike = 0
      for (let c = 0; c < kids.length; c++) {
        if (hitsOf(kids[c].textContent || '') > 0) rowLike += 1
      }
      if (rowLike < 2) continue
      const score = rowLike * 100 + hits
      if (score > bestScore) {
        best = node
        bestScore = score
      }
    }
    return best
  }

  /**
   * 设置页的这四个按钮（导出/导入/清空/打开目录）。
   *
   * 只能做成**运行期注入**：Vnite 的插件 `configuration` 只有 input/switch/select/
   * slider 这类声明式控件，没有按钮类型（`ConfigItem` 不支持 button，`custom` 又需要
   * 主进程传不过去的 React 节点），所以按钮必须由插件自己被激活后往 DOM 里插。
   * 插件被停用时 Vnite 根本不会加载插件模块，这些按钮也就不存在 —— 这是插件模型
   * 的限制，不是样式问题。
   *
   * 位置：当成**一行普通设置项**接在配置列表最后（`rows` 容器的末尾），
   * 外观由 `adoptNativeStyle()` 从相邻原生行拷贝，看起来跟 API Key 那些行一致。
   */
  let settingsBar: HTMLElement | null = null

  /** 原生配置行的标题文案，用来在 DOM 里反向定位一行真实的 Card */
  const NATIVE_ROW_TITLES = [
    '本地限流（次/分）',
    '缓存有效期（小时）',
    '深度刮削人数',
    'VNDB 兜底',
    '人物头像下载到本地',
    '导出时带上图片',
    'API Key',
    '基础 URL',
    '界面语言',
    '语言',
    '允许 NSFW 内容'
  ]

  /**
   * 找到一行**原生**设置项的 Card 节点。
   *
   * 结构（Vnite 打包后的 ConfigItem）：
   *   Card(div.w-full.pb-5) > CardContent(div) > [ 左(flex-col) > 标题/说明, 右(flex-shrink-0.ml-6) > 控件 ]
   * 所以从「只装标题文字的叶子 div」往上爬三层就是 Card。
   */
  function nativeRowSample(): HTMLElement | null {
    const nodes = Array.prototype.slice.call(document.querySelectorAll('div')) as HTMLElement[]
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      if (node.children.length > 0) continue
      if (node.closest('#vncp-settings-tools')) continue
      const text = (node.textContent || '').trim()
      if (NATIVE_ROW_TITLES.indexOf(text) < 0) continue
      const left = node.parentElement
      const content = left && left.parentElement
      const card = content && content.parentElement
      if (card && card !== document.body && card.children.length === 1) return card
    }
    return null
  }

  /** 找对话框底部的原生按钮（优先「取消 / Cancel」这种次级按钮），拿来当按钮模板 */
  function nativeButtonSample(): HTMLButtonElement | null {
    const scope = (document.querySelector('[role="dialog"]') as HTMLElement | null) || document.body
    const nodes = Array.prototype.slice
      .call(scope.querySelectorAll('button'))
      .filter(function (node: HTMLElement) {
        if (node.closest('#vncp-settings-tools')) return false
        return /取消|保存|应用|Cancel|Save|Apply/i.test((node.textContent || '').trim())
      }) as HTMLButtonElement[]
    if (!nodes.length) return null
    const secondary = nodes.filter(function (node) {
      const style = window.getComputedStyle(node)
      return style.backgroundColor === 'rgba(0, 0, 0, 0)' || style.backgroundColor === 'transparent'
    })
    return secondary[0] || nodes[0]
  }

  /**
   * 设置页的这四个按钮（导出/导入/清空/打开目录）。
   *
   * 只能做成**运行期注入**：Vnite 的插件 `configuration` 只有 input/switch/select/
   * slider 这类声明式控件，没有按钮类型（`ConfigItem` 不支持 button，`custom` 又需要
   * 主进程传不过去的 React 节点），所以按钮必须由插件自己被激活后往 DOM 里插。
   * 插件被停用时 Vnite 根本不会加载插件模块，这些按钮也就不存在 —— 这是插件模型
   * 的限制，不是样式问题。
   *
   * 位置：当成**一行普通设置项**接在配置列表最后（`rows` 容器的末尾）。
   * 外观：直接把同容器里一条原生设置行**整棵 DOM 克隆**过来，再把标题/说明/控件换成
   * 我们自己的内容 —— 这样主题、玻璃拟态、亮暗模式、Tailwind 类名全都天然一致，
   * 比「拷 computedStyle」稳（有些主题下原生行是透明底，拷不出可用的样式）。
   */
  function settingsBarEl(): HTMLElement {
    if (settingsBar && settingsBar.isConnected) return settingsBar

    const sample = nativeRowSample()
    let bar: HTMLElement
    let left: HTMLElement
    let right: HTMLElement
    let titleTpl: HTMLElement | null = null
    let descTpl: HTMLElement | null = null

    if (sample) {
      bar = sample.cloneNode(true) as HTMLElement
      const content = bar.firstElementChild as HTMLElement | null
      left = content && content.children[0] ? (content.children[0] as HTMLElement) : bar
      right = content && content.children[1] ? (content.children[1] as HTMLElement) : bar
      // 留下标题 / 说明的模板（连同它们的原生 class），换掉文字就能保持原生排版
      titleTpl = (left.children[0] as HTMLElement) || null
      descTpl = (left.children[1] as HTMLElement) || null
      if (titleTpl) titleTpl = titleTpl.cloneNode(true) as HTMLElement
      if (descTpl) descTpl = descTpl.cloneNode(true) as HTMLElement
      while (left.firstChild) left.removeChild(left.firstChild)
      while (right.firstChild) right.removeChild(right.firstChild)
      bar.setAttribute('data-vncp-clone', '1')
    } else {
      bar = el('div', 'vncp-settings-tools')
      left = el('div', 'vncp-settings-label')
      right = el('div')
      bar.appendChild(left)
      bar.appendChild(right)
    }

    bar.id = 'vncp-settings-tools'
    bar.style.display = ''
    if (!sample) bar.classList.add('vncp-settings-tools')

    // 左半边：跟其它配置项一样的「标题 + 说明」
    const name = (titleTpl || el('div', 'vncp-settings-name', '')) as HTMLElement
    name.classList.add('vncp-settings-name')
    name.textContent = '人物数据'
    const desc = (descTpl || el('div', 'vncp-settings-desc', '')) as HTMLElement
    desc.classList.add('vncp-settings-desc')
    desc.textContent = '导出 / 导入 / 清空人物缓存，或直接打开图片缓存目录'
    left.appendChild(name)
    left.appendChild(desc)

    // 右半边：四个按钮（有原生按钮可抄就抄外观，没有就用内置样式）
    const actions = el('div', 'vncp-settings-actions')
    const template = sample ? nativeButtonSample() : null
    const tools: Array<[string, string]> = [
      ['导出人物数据', 'export'],
      ['导入人物数据', 'import'],
      ['清空全部人物', 'clear-all'],
      ['缓存统计', 'stats'],
      ['打开缓存目录', 'open-dir']
    ]
    for (let i = 0; i < tools.length; i++) {
      const spec = tools[i]
      const btn = (template
        ? template.cloneNode(true)
        : el('button', 'vncp-settings-btn', '')) as HTMLButtonElement
      btn.type = 'button'
      btn.classList.add('vncp-settings-btn')
      btn.textContent = spec[0]
      btn.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        if (spec[1] === 'clear-all' && !window.confirm('确定清空所有作品的人物缓存吗？')) return
        const status = document.getElementById('vncp-settings-status')
        if (status) status.textContent = '⏳ 已提交：' + spec[0]
        if (spec[1] === 'stats') {
          if (status) status.textContent = ''
          openStats()
          return
        }
        enqueue({ cmd: spec[1] })
      })
      actions.appendChild(btn)
    }
    right.appendChild(actions)

    const status = el('span', 'vncp-settings-status', '')
    status.id = 'vncp-settings-status'
    left.appendChild(status)

    settingsBar = bar
    host.__VNCP_BAR_CREATED__ = Number(host.__VNCP_BAR_CREATED__ || 0) + 1
    return bar
  }

  /**
   * 把这一行做成「Vnite 自己画的样子」：从同容器里的原生配置行拷背景、圆角、边框、
   * 内边距与字体色，从对话框底部按钮拷按钮样式。
   *
   * 为什么拷计算样式而不是写死 Tailwind 类名：主题、亮/暗模式、玻璃拟态都由
   * Vnite 的 CSS 变量决定，抄一份最终的 computedStyle 才能在任何主题下都对得上。
   */
  function adoptNativeStyle(bar: HTMLElement, rows: HTMLElement): void {
    try {
      const children = Array.prototype.slice.call(rows.children) as HTMLElement[]
      let card: HTMLElement | null = null
      for (let i = 0; i < children.length; i++) {
        const child = children[i]
        if (child === bar || child.id === 'vncp-settings-tools' || child.contains(bar)) continue
        const inner = child.querySelector('div')
        const candidate = inner instanceof HTMLElement ? inner : child
        const style = window.getComputedStyle(candidate)
        if (parseFloat(style.borderRadius) > 0 && style.backgroundColor !== 'rgba(0, 0, 0, 0)') {
          card = candidate
          break
        }
      }
      if (card) {
        const cs = window.getComputedStyle(card)
        bar.style.background = cs.backgroundColor
        bar.style.backgroundImage = cs.backgroundImage
        bar.style.borderRadius = cs.borderRadius
        bar.style.borderStyle = cs.borderStyle
        bar.style.borderWidth = cs.borderWidth
        bar.style.borderColor = cs.borderColor
        bar.style.boxShadow = cs.boxShadow
        bar.style.paddingTop = cs.paddingTop
        bar.style.paddingRight = cs.paddingRight
        bar.style.paddingBottom = cs.paddingBottom
        bar.style.paddingLeft = cs.paddingLeft
        // 标题 / 说明的文字样式：卡片里前两个「只装文字」的 div
        const texts = Array.prototype.slice
          .call(card.querySelectorAll('div'))
          .filter(function (node: HTMLElement) {
            return node.children.length === 0 && (node.textContent || '').trim().length > 0
          }) as HTMLElement[]
        const name = bar.querySelector('.vncp-settings-name') as HTMLElement | null
        const desc = bar.querySelector('.vncp-settings-desc') as HTMLElement | null
        if (name && texts[0]) {
          const ts = window.getComputedStyle(texts[0])
          name.style.fontSize = ts.fontSize
          name.style.fontWeight = ts.fontWeight
          name.style.color = ts.color
          name.style.lineHeight = ts.lineHeight
        }
        if (desc && texts[1]) {
          const ds = window.getComputedStyle(texts[1])
          desc.style.fontSize = ds.fontSize
          desc.style.color = ds.color
          desc.style.lineHeight = ds.lineHeight
          desc.style.opacity = ds.opacity
        }
      }

      // 按钮：抄对话框底部的「取消」这类次级按钮（不要抄「保存」那种主色实心按钮，
      // 一排四个按钮全实心会喧宾夺主，而且和设置行里的说明文字抢视线）
      const scope = (bar.closest('[role="dialog"]') as HTMLElement | null) || document.body
      const native = Array.prototype.slice
        .call(scope.querySelectorAll('button'))
        .filter(function (node: HTMLElement) {
          if (node.closest('#vncp-settings-tools')) return false
          return /取消|保存|应用|Cancel|Save|Apply/i.test((node.textContent || '').trim())
        }) as HTMLElement[]
      const secondary = native.filter(function (node: HTMLElement) {
        const style = window.getComputedStyle(node)
        return style.backgroundColor === 'rgba(0, 0, 0, 0)' || style.backgroundColor === 'transparent'
      })
      const sample = secondary[0] || native[0]
      if (!sample) return
      const bs = window.getComputedStyle(sample)
      const buttons = bar.querySelectorAll('.vncp-settings-btn')
      for (let i = 0; i < buttons.length; i++) {
        const btn = buttons[i] as HTMLElement
        btn.style.backgroundColor = bs.backgroundColor
        btn.style.backgroundImage = bs.backgroundImage
        btn.style.borderColor = bs.borderColor
        btn.style.borderStyle = bs.borderStyle
        btn.style.borderWidth = bs.borderWidth
        btn.style.borderRadius = bs.borderRadius
        btn.style.color = bs.color
        btn.style.fontSize = bs.fontSize
        btn.style.fontWeight = bs.fontWeight
        btn.style.lineHeight = bs.lineHeight
        btn.style.paddingTop = bs.paddingTop
        btn.style.paddingBottom = bs.paddingBottom
        btn.style.paddingLeft = bs.paddingLeft
        btn.style.paddingRight = bs.paddingRight
        btn.style.boxShadow = bs.boxShadow
      }
    } catch (error) {
      void error
    }
  }

  /** 注入节流：避免每次 tick 都挪 DOM（那才是闪烁的根源） */
  let lastInjectAt = 0

  function injectSettingsTools(): void {
    ensureCss()
    const rows = settingsRows()
    if (!rows) return
    const now = Date.now()
    const existing = document.getElementById('vncp-settings-tools')
    if (existing && existing.parentElement === rows) return
    if (now - lastInjectAt < 300) return
    if (existing && existing.parentElement) existing.parentElement.removeChild(existing)
    lastInjectAt = now
    const bar = settingsBarEl()
    bar.style.display = ''
    rows.appendChild(bar)
    // 克隆原生行的不需要再抄样式；只有兜底那条自己画的才要（元素得先在文档里才能算）
    if (bar.getAttribute('data-vncp-clone') !== '1') adoptNativeStyle(bar, rows)
  }

  function bindNativeTabs(list: HTMLElement): void {
    const tabs = tabsOf(list)
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i]
      if (tab.id === TAB_ID) continue
      if (boundTabs.has(tab)) continue
      boundTabs.add(tab)
      tab.addEventListener(
        'click',
        function () {
          if (active) setActive(false)
        },
        true
      )
    }
  }

  function mount(): void {
    const list = findTablist()
    if (!list) return
    pruneDuplicates(list)
    detectLang(list)
    ensureCss()

    let tab = document.getElementById(TAB_ID) as HTMLElement | null
    if (!tab || !list.contains(tab)) {
      if (tab && tab.parentElement) tab.parentElement.removeChild(tab)
      const created = createTab()
      if (created) {
        // 「人物」紧贴「概览」右侧（记录/存档/回忆依次右移）
        const tabs = tabsOf(list).filter(function (node) {
          return node.id !== TAB_ID
        })
        let anchor: HTMLElement | null = null
        for (let i = 0; i < tabs.length; i++) {
          if (OVERVIEW_TEXT.test((tabs[i].textContent || '').trim())) {
            anchor = tabs[i]
            break
          }
        }
        if (!anchor && tabs.length) anchor = tabs[0]
        if (anchor && anchor.parentElement === list) list.insertBefore(created, anchor.nextSibling)
        else list.appendChild(created)
      }
    }
    ensurePanel()
    bindNativeTabs(list)
    // 关键：Radix 的 TabsContent 在非激活时会把内容卸载掉，切到「人物」后「概览」
    // 里的原名/译名就不在 DOM 里了。趁现在（概览还挂着）先读一份存进 __VNCP_TITLE__。
    try {
      namesFromPane()
    } catch (error) {
      void error
    }
    // 每轮都重写一次：React 重渲染可能把 tablist 的内联样式冲掉，导致第 5 个标签掉到第二行
    fitRow(list)
    if (active) setActive(true)
  }

  function removeNodes(): void {
    const tab = document.getElementById(TAB_ID)
    if (tab && tab.parentElement) tab.parentElement.removeChild(tab)
    const panel = panelEl()
    if (panel && panel.parentElement) panel.parentElement.removeChild(panel)
    livePanel = null
    restoreNatives()
  }

  function tick(): void {
    const list = findTablist()
    if (!list) {
      if (document.getElementById(TAB_ID) || document.getElementById(PANEL_ID)) {
        if (active) {
          active = false
          restoreNatives()
        }
        removeNodes()
      }
      try {
        injectSettingsTools()
      } catch (error) {
        host.__VNCP_SETTINGS_ERR__ = error instanceof Error ? error.stack || error.message : String(error)
      }
      return
    }
    pruneDuplicates(list)
    if (!document.getElementById(TAB_ID) || !panelEl()) mount()
    fitRow(list)
    try {
      injectSettingsTools()
    } catch (error) {
      host.__VNCP_SETTINGS_ERR__ = error instanceof Error ? error.stack || error.message : String(error)
    }
    if (!active) return
    // 激活期间只隐藏同一组里的原生面板；**不再**每轮改写原生标签的 data-state，
    // 那是「点回概览/记录时下划线消失」的元凶。
    const panels = panelsOf(list)
    for (let i = 0; i < panels.length; i++) {
      if (panels[i].id === PANEL_ID) continue
      if (panels[i].getAttribute('data-vncp-prev') == null) {
        panels[i].setAttribute('data-vncp-prev', panels[i].style.display || '')
      }
      if (panels[i].style.display !== 'none') panels[i].style.display = 'none'
    }
    // 换作品：路由变了就立刻重画（不等版本号变），并让主进程按 gameId 取一次数据。
    // 这一步同时修掉两个老问题：切作品后还显示上一部的人物、以及切过来时一片空白。
    const routeNow = routeGameId()
    if (host.__VNCP_ROUTE__ !== routeNow) {
      host.__VNCP_ROUTE__ = routeNow
      delete host.__VNCP_STATUS__
      // 换作品就清空「搜索 / 筛选 / 诊断」状态：否则上一部作品里搜的词会顶掉新作品的人物栏
      host.__VNCP_SEARCH__ = ''
      host.__VNCP_FILTER__ = null
      host.__VNCP_KEY__ = ''
      const data = host.__VNCP_DATA__ || null
      const matched = routeNow ? currentGame(data) : null
      if (routeNow && !matched) requestData(guessTitle())
      render()
    }
    const own = panelEl()
    if (own) {
      if (own.style.display !== 'block') own.style.display = 'block'
      // 自愈：React 重渲染可能重建我们的容器（内容为空），版本号不一致就重画
      // 只比版本号不够：切游戏时版本号不变，会一直显示上一部作品的人物
      refreshIfStale()
      repairPlacement()
    }
  }

  function schedule(): void {
    if (scheduled) return
    scheduled = true
    const run = function (): void {
      scheduled = false
      try {
        tick()
      } catch (error) {
        host.__VNCP_ERR__ = error instanceof Error ? error.message : String(error)
      }
    }
    // 不要用 requestAnimationFrame：窗口不可见 / 被遮挡时浏览器会暂停 rAF，
    // scheduled 会永久卡在 true，之后所有 tick 都被这行短路掉（表现为「切游戏后
    // 面板还是上一部的人物」）。setTimeout 不受可见性影响。
    window.setTimeout(run, 16)
  }

  function ours(node: Node | null): boolean {
    let cur: Node | null = node
    while (cur && cur !== document.body) {
      const element = cur as Element
      if (element.id === 'vncp-settings-tools' || element.id === 'vncp-panel' || element.id === 'vncp-tab') return true
      if (element.classList && (element.classList.contains('vncp-modal') || element.classList.contains('vncp-zoom'))) return true
      cur = element.parentNode
    }
    return false
  }

  const observer = new MutationObserver(function (records) {
    // 全是自己引起的变更 → 不再调度（否则 render 改 DOM、observer 又调度 render，来回闪）
    let foreign = false
    for (let i = 0; i < records.length; i++) {
      if (!ours(records[i].target)) {
        foreign = true
        break
      }
    }
    if (foreign) schedule()
  })
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-state', 'aria-selected', 'class']
  })
  const timer = window.setInterval(schedule, 1500)

  host.__VNCP_RENDER__ = function (): void {
    try {
      render()
    } catch (error) {
      void error
    }
  }
  host.__VNCP_REPORT__ = function (payload: any): void {
    // 设置页里的工具栏也要能看到结果（导出路径、导入条数…）
    const settingsStatus = document.getElementById('vncp-settings-status')
    if (settingsStatus && payload && typeof payload.text === 'string') {
      settingsStatus.textContent = payload.text
    }
  }
  host.__VNCP_TEARDOWN__ = function (): void {
    closeZoom()
    closeDetail()
    try {
      observer.disconnect()
    } catch (error) {
      void error
    }
    window.clearInterval(timer)
    active = false
    removeNodes()
    delete host.__VNCP_HOST__
    delete host.__VNCP_RENDER__
    delete host.__VNCP_REPORT__
    delete host.__VNCP_STATUS__
    delete host.__VNCP_DATA__
    delete host.__VNCP_QUEUE__
    delete host.__VNCP_TEARDOWN__
  }

  mount()
  // 立刻注入对话框里的「人物（插件）」行：用户可能在脚本就位后马上打开对话框
  try {
    injectSettingsTools()
  } catch (error) {
    host.__VNCP_SETTINGS_ERR__ = error instanceof Error ? error.stack || error.message : String(error)
  }
  schedule()
  try {
    // 告诉主进程「注入脚本已就位」，请补推一次快照（消除注入晚于首次推送的竞态）
    console.info('__VNCP:HELLO')
  } catch (error) {
    void error
  }
}

/** 可直接交给 webContents.executeJavaScript 的表达式 */
export const BOOTSTRAP_SOURCE = '(' + nativeBootstrap.toString() + ')();'
