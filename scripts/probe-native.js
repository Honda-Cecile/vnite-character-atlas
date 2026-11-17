/**
 * 原生注入探针（本地验证，不进包）。
 *
 * 做四件事：
 *   1. 用真实 KunGalgame 数据跑一遍插件 → CharacterPanelData
 *   2. 用 NativeTabInjector.setGame 生成真实快照（验证字段映射/裁剪）
 *   3. 造两个仿 Vnite 的 mock 页交给 headless Chrome：
 *      · mock-detail.html  —— 4 列 grid 的 Radix Tabs（最容易换行的形态）+ 只有「基本信息」没有 h1
 *                            用来验证：标签插到概览右侧、5 列不换行、靠原名/译名匹配到游戏
 *      · mock-dialog.html  —— 「更新游戏元数据」对话框，验证「人物（插件）」行是否注入
 *   4. 用 --dump-dom 断言标签顺序与对话框行，用 --screenshot 出图
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const pluginModule = require('../dist/index.js')
const plugin = pluginModule.default || pluginModule
const { NativeTabInjector, BOOTSTRAP_SOURCE } = pluginModule

const OUT = path.resolve(__dirname, '..', '.tmp', 'native')
const CHROME =
  process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
fs.mkdirSync(OUT, { recursive: true })

const kv = new Map()
const ipcHandlers = {}

const GAME = {
  _id: 'clannad',
  metadata: {
    name: 'CLANNAD | 克兰纳德',
    originalName: 'クラナド',
    vndbId: 'v86',
    relatedSites: [{ label: 'vndb', url: 'https://vndb.org/v86' }]
  }
}

const api = {
  pluginId: 'character-atlas',
  PluginDB: {
    getValue: async (key, def) => (kv.has(key) ? kv.get(key) : def),
    setValue: async (key, value) => void kv.set(key, value)
  },
  ConfigDB: { getConfigValue: async () => undefined, setConfigValue: async () => {} },
  GameDB: {
    getGame: async () => GAME,
    setGame: async () => {},
    getAllGames: async () => ({ clannad: GAME })
  },
  eventBus: { on: () => () => {}, off: () => {}, emit: async () => {} },
  ipc: {
    handle: (channel, handler) => {
      ipcHandlers[channel] = handler
    },
    removeHandler: (channel) => {
      delete ipcHandlers[channel]
    },
    on: () => {},
    send: () => {}
  },
  scraper: { registerProvider: () => {}, unregisterProvider: () => {} }
}

function chrome(args) {
  return execFileSync(CHROME, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function dumpDom(file) {
  return chrome([
    '--headless=new',
    '--disable-gpu',
    '--virtual-time-budget=9000',
    '--dump-dom',
    'file:///' + file.replace(/\\/g, '/')
  ])
}

async function main() {
  await plugin.activate(api)
  const injector = new NativeTabInjector({ label: '', log: (m) => console.log(m) })
  const snapshotPath = path.join(OUT, 'snapshot.json')
  let snapshot = null
  try {
    const panel = await ipcHandlers['character-atlas:get']({ gameId: 'clannad' })
    if (!panel || panel.error) throw new Error('刮削失败: ' + JSON.stringify(panel && panel.error))
    await injector.setGame('clannad', ['CLANNAD | 克兰纳德', 'クラナド'], panel)
    const fresh = injector.snapshot()
    if (fresh.games.length && fresh.games[0].characters.length) {
      snapshot = fresh
      fs.writeFileSync(snapshotPath, JSON.stringify(fresh), 'utf8')
    }
  } catch (error) {
    console.log('实时刮削失败（网络/额度），改用快照:', String(error).slice(0, 160))
  }
  if (!snapshot) {
    try {
      snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
      console.log('已复用上次快照:', snapshotPath)
    } catch (error) {
      throw new Error('没有可用快照，且实时刮削失败: ' + String(error))
    }
  }
  console.log(
    `快照: games=${snapshot.games.length} characters=${snapshot.games[0].characters.length} enriched=${snapshot.games[0].enriched}`
  )

  // ---- 立绘用例：Kungal 的角色卡是「全身立绘 + 头像」两张图 ----
  // CLANNAD 的角色在目录里 figure 全为 null，所以这里取一部确实有立绘的作品（#117），
  // 经 ImageCache 落成本地 data URI，验证弹窗能否画出两张图。
  let figureOk = true
  let figureNote = '跳过'
  try {
    const listRes = await fetch(
      'https://api.nextmoe.dev/v2/catalog/works/117/characters?include=figure,image&nsfw=true&limit=20'
    )
    const listJson = await listRes.json()
    const withFigure = (listJson.items || []).find((item) => item.figure && item.figure.url)
    if (!withFigure) throw new Error('列表里没有带 figure 的角色')
    const { ImageCache } = pluginModule
    const cache = new ImageCache(() => {})
    const figUri = await cache.resolve(withFigure.figure.url)
    if (!figUri || figUri.indexOf('data:image') !== 0) throw new Error('立绘没有转成 data URI')
    const figureData = JSON.parse(JSON.stringify(snapshot))
    const hero = figureData.games[0].characters[0]
    hero.n = withFigure.display_name || hero.n
    hero.fig = figUri
    hero.figSrc = withFigure.figure.url
    hero.img = figUri
    hero.src = withFigure.figure.url
    hero.traits = [
      { g: '被动(性)', n: '女上位体位', s: true },
      { g: '毛发', n: '棕色' }
    ]
    hero.introSource = 'bangumi'
    hero.introMachine = true
    const figureFile = path.join(OUT, 'mock-figure.html')
    fs.writeFileSync(
      figureFile,
      buildDetailHtml(BOOTSTRAP_SOURCE, JSON.stringify(figureData)),
      'utf8'
    )
    const dom = dumpDom(figureFile).replace(/<script[\s\S]*?<\/script>/g, '')
    const hasFigureImg = /vncp-dialog-figure[\s\S]{0,400}?<img/.test(dom)
    const hasSexMark = /被动\(性\)[\s\S]{0,120}?·性/.test(dom)
    const hasMachine = /（机器翻译）/.test(dom)
    figureOk = hasFigureImg && hasSexMark && hasMachine
    figureNote = '立绘=' + hasFigureImg + ' 性标记=' + hasSexMark + ' 机翻标注=' + hasMachine
    chrome(['--headless=new', '--disable-gpu', '--hide-scrollbars', '--virtual-time-budget=6000',
      '--window-size=1400,900', '--screenshot=' + path.join(OUT, 'mock-figure.png'),
      'file:///' + figureFile.replace(/\\/g, '/')])
  } catch (error) {
    figureOk = false
    figureNote = String(error).slice(0, 120)
  }
  console.log('立绘弹窗:', figureNote, figureOk ? '✓' : '✗')

  // ---- 路由身份用例：hash 里的 gameId 优先于页面上的文字 ----
  // Vnite 用 TanStack Router + createHashHistory，地址是 `index.html#/library/games/<gameId>/<groupId>`。
  // 之前只靠「基本信息」里的名字匹配，概览被卸载/刚切过游戏时会读到上一部作品的名字，
  // 表现就是「所有作品共用一个人物栏」。这里把页面文字故意留成 CLANNAD、
  // 路由指向 other-game，面板必须画 other-game 的人物。
  const routeData = JSON.stringify({
    v: 21,
    label: '',
    games: [
      {
        id: 'clannad',
        names: ['クラナド', 'CLANNAD | 克兰纳德'],
        source: 'kungal',
        workName: 'CLANNAD | 克兰纳德',
        total: 1,
        enriched: 1,
        characters: [{ n: 'CLANNAD 的角色', role: '主角', intro: 'A' }]
      },
      {
        id: 'other-game',
        names: ['思影'],
        source: 'kungal',
        workName: '思影',
        total: 1,
        enriched: 1,
        characters: [{ n: 'OTHER_路由指向的角色', role: '主角', intro: 'B' }]
      }
    ]
  })
  const routeFileA = path.join(OUT, 'mock-route-a.html')
  const routeFileB = path.join(OUT, 'mock-route-b.html')
  fs.writeFileSync(routeFileA, buildDetailHtml(BOOTSTRAP_SOURCE, routeData), 'utf8')
  fs.writeFileSync(routeFileB, buildDetailHtml(BOOTSTRAP_SOURCE, routeData), 'utf8')
  const hashA = path.join(OUT, 'mock-route-a.html').replace(/\\/g, '/') + '#/library/games/other-game/all'
  const hashB = path.join(OUT, 'mock-route-b.html').replace(/\\/g, '/') + '#/library/games/unknown-game/all'
  const domA = dumpDom(hashA).replace(/<script[\s\S]*?<\/script>/g, '')
  const domB = dumpDom(hashB).replace(/<script[\s\S]*?<\/script>/g, '')
  const routeWins =
    /OTHER_路由指向的角色/.test(domA) && !/CLANNAD 的角色/.test(domA)
  const routeEmpty = !/CLANNAD 的角色/.test(domB) && !/OTHER_路由指向的角色/.test(domB)
  const routeOk = routeWins && routeEmpty
  console.log(
    '路由身份:',
    'hash=other-game 画 other=' + routeWins,
    '| hash=unknown 不画别家=' + routeEmpty,
    routeOk ? '✓' : '✗'
  )

  // ---- 去重用例：伪造一个「上一部作品残留」的面板叠在上面 ----
  // React 重建详情页时我们的容器可能被挂到别处继续可见，
  // 之前的表现就是一整排半透明卡片和当前作品的卡片叠在一起。
  const dupeExtra = `
<script>
  setTimeout(function () {
    var panel = document.getElementById('vncp-panel');
    if (!panel || !panel.parentNode) return;
    var clone = panel.cloneNode(true);
    clone.setAttribute('data-stale', '1');
    var ghost = document.createElement('div');
    ghost.className = 'vncp-card';
    ghost.textContent = '残留卡片_不该出现';
    clone.appendChild(ghost);
    panel.parentNode.appendChild(clone);
  }, 2200);
  setTimeout(function () {
    document.title = 'DUPES:' + document.querySelectorAll('#vncp-panel').length +
      ':|' + (document.body.innerText.indexOf('残留卡片_不该出现') >= 0 ? '1' : '0');
  }, 5200);
</script>
`
  const dupeRaw = buildDetailHtml(BOOTSTRAP_SOURCE, JSON.stringify(snapshot))
  const dupeHtml = dupeRaw.indexOf('</body>') >= 0
    ? dupeRaw.replace('</body>', dupeExtra + '</body>')
    : dupeRaw + dupeExtra
  const dupeFile = path.join(OUT, 'mock-dupe.html')
  fs.writeFileSync(dupeFile, dupeHtml, 'utf8')
  const dupeDom = dumpDom(dupeFile).replace(/<script[\s\S]*?<\/script>/g, '')
  const dupePanels = (dupeDom.match(/id="vncp-panel"/g) || []).length
  const dupeStale = /残留卡片_不该出现/.test(dupeDom)
  const dupeOk = dupePanels === 1 && !dupeStale
  console.log('重复面板: 面板数=' + dupePanels + ' 残留可见=' + dupeStale + ' ' + (dupeOk ? '✓' : '✗'))

  // ---- 下划线用例：切回原生「概览」时它必须重新拿到 active 状态 ----
  // 旧实现每轮把所有原生标签改成 inactive，Radix 刚画上的下划线立刻被抹掉，
  // 于是「点概览/记录后小白条消失」。现在只在激活我们时压制、取消时按原值还原。
  const restoreExtra = `
<script>
  setTimeout(function () { var t = document.getElementById('vncp-tab'); if (t) t.click(); }, 1500);
  setTimeout(function () {
    var list = document.querySelector('[role="tablist"]');
    var overview = list && list.querySelector('[role="tab"]');
    if (overview) overview.click();
  }, 3000);
  setTimeout(function () {
    var list = document.querySelector('[role="tablist"]');
    var tabs = list ? Array.prototype.slice.call(list.querySelectorAll('[role="tab"]')) : [];
    var activeNative = tabs.filter(function (t) {
      return t.id !== 'vncp-tab' && t.getAttribute('data-state') === 'active';
    }).length;
    var own = document.getElementById('vncp-tab');
    document.title = 'RESTORE:' + activeNative + ':|' + (own ? own.getAttribute('data-state') : 'none');
  }, 5200);
</script>
`
  const restoreRaw = buildDetailHtml(BOOTSTRAP_SOURCE, JSON.stringify(snapshot))
  const restoreHtml =
    restoreRaw.indexOf('</body>') >= 0
      ? restoreRaw.replace('</body>', restoreExtra + '</body>')
      : restoreRaw + restoreExtra
  const restoreFile = path.join(OUT, 'mock-restore.html')
  fs.writeFileSync(restoreFile, restoreHtml, 'utf8')
  const restoreDom = dumpDom(restoreFile).replace(/<script[\s\S]*?<\/script>/g, '')
  const tablistChunk = (restoreDom.match(/<div role="tablist"[\s\S]*?<\/div>/) || [''])[0]
  const nativeActive = (tablistChunk.match(/data-state="active"/g) || []).length
  const ownInactive = /id="vncp-tab"[^>]*data-state="inactive"/.test(tablistChunk) ||
    /data-state="inactive"[^>]*id="vncp-tab"/.test(tablistChunk)
  const restoreOk = nativeActive >= 1 && ownInactive
  console.log(
    '下划线恢复: 原生 active=' + nativeActive + ' 我们已退选=' + ownInactive + ' ' + (restoreOk ? '✓' : '✗')
  )

  const dataJson = JSON.stringify(snapshot)
  const detailFile = path.join(OUT, 'mock-detail.html')
  const dialogFile = path.join(OUT, 'mock-dialog.html')
  const recordsFile = path.join(OUT, 'mock-records.html')
  fs.writeFileSync(detailFile, buildDetailHtml(BOOTSTRAP_SOURCE, dataJson), 'utf8')
  fs.writeFileSync(dialogFile, buildDialogHtml(BOOTSTRAP_SOURCE, dataJson), 'utf8')
  fs.writeFileSync(recordsFile, buildRecordsHtml(BOOTSTRAP_SOURCE, dataJson), 'utf8')
  const scrapeFile = path.join(OUT, 'mock-scrape.html')
  fs.writeFileSync(scrapeFile, buildScrapeHtml(BOOTSTRAP_SOURCE, dataJson), 'utf8')
  // 空态/未匹配态：面板里必须永远看得见「开始刮削」，否则用户没有任何自救入口
  const emptyData = JSON.stringify({
    v: 99,
    label: '',
    games: [
      {
        id: 'no-such-game',
        names: ['某部未收录的作品'],
        source: 'kungal',
        workName: '某部未收录的作品',
        total: 0,
        enriched: 0,
        characters: []
      }
    ]
  })
  // 缓存里只有「思影」，但当前页是 NOBLE☆WORKS 且读不到基本信息 → 必须空态，不能张冠李戴
  const mismatchData = JSON.stringify({
    v: 3,
    label: '',
    games: [
      {
        id: 'other-game',
        names: ['思影'],
        source: 'kungal',
        workName: '思影',
        total: 2,
        enriched: 2,
        characters: [
          { n: '立花 月下', role: '主角', intro: '别的游戏的人物' },
          { n: '鈴 雛実', role: '主角', intro: '别的游戏的人物' }
        ]
      }
    ]
  })
  // 真实 Vnite 形态：基本信息在「概览」这个 tabpanel 里面，切到「人物」后概览被 display:none
  const hiddenData = JSON.stringify({
    v: 5,
    label: '',
    games: [
      {
        id: 'other-game',
        names: ['思影'],
        source: 'kungal',
        workName: '思影',
        total: 1,
        enriched: 1,
        characters: [{ n: '立花 月下', role: '主角', intro: '别的游戏的人物' }]
      }
    ]
  })
  const hiddenFile = path.join(OUT, 'mock-hidden.html')
  fs.writeFileSync(hiddenFile, buildHiddenPaneHtml(BOOTSTRAP_SOURCE, hiddenData), 'utf8')

  // 切游戏回归：快照里有两部作品，页面基本信息是 B（且在隐藏的概览面板里），
  // 面板必须画 B 的人物，绝不能继续显示上一部 A 的名单。
  const switchData = JSON.stringify({
    v: 9,
    label: '',
    games: [
      {
        id: 'game-a',
        names: ['思影'],
        source: 'kungal',
        workName: '思影',
        total: 1,
        enriched: 1,
        characters: [{ n: 'AAA_上一部作品的人物', role: '主角', intro: 'A 的简介' }]
      },
      {
        id: 'game-b',
        names: ['のーぶる☆わーくす', 'NOBLE☆WORKS'],
        source: 'kungal',
        workName: 'NOBLE☆WORKS',
        total: 2,
        enriched: 2,
        characters: [
          { n: '兼元 灯里', role: '主角', intro: 'B 的第一位角色' },
          { n: '月山瀬 奈', role: '主角', intro: 'B 的第二位角色' }
        ]
      }
    ]
  })
  const switchFile = path.join(OUT, 'mock-switch.html')
  fs.writeFileSync(switchFile, buildSwitchHtml(BOOTSTRAP_SOURCE, switchData), 'utf8')

  const mismatchFile = path.join(OUT, 'mock-mismatch.html')
  fs.writeFileSync(mismatchFile, buildMismatchHtml(BOOTSTRAP_SOURCE, mismatchData), 'utf8')

  const emptyFile = path.join(OUT, 'mock-empty.html')
  fs.writeFileSync(emptyFile, buildDetailHtml(BOOTSTRAP_SOURCE, emptyData), 'utf8')

  // ---- 断言 1：标签顺序与数量 ----
  const detailDom = dumpDom(detailFile)
  // 剥掉注入脚本源码，否则会出现「源码里含 class="vncp-card" 字样」这类假阳性
  const detailBody = detailDom.replace(/<script[\s\S]*?<\/script>/g, '')
  const tabLabels = Array.from(detailDom.matchAll(/id="vncp-tab"[^>]*>|role="tab"[^>]*>([^<]*)</g))
    .map((m) => (m[1] || '').trim())
    .filter(Boolean)
  const tablistHtml = (detailBody.match(/role="tablist"[\s\S]{0,1200}?<\/div>/) || [''])[0]
  const order = Array.from(tablistHtml.matchAll(/>([^<>]{2,6})</g)).map((m) => m[1].trim())
  console.log('标签栏文本顺序:', JSON.stringify(order))
  const expect = ['概览', '人物', '记录', '存档', '回忆']
  const orderOk = JSON.stringify(order.slice(0, 5)) === JSON.stringify(expect)
  // 只看 tablist 开标签上的内联 style（<style> 里那条 repeat(4,...) 是原始写法）
  const tablistTag = (detailBody.match(/<div role="tablist"[^>]*>/) || [''])[0]
  const inlineCols = (tablistTag.match(/grid-template-columns:\s*([^;"]+)/) || [])[1] || ''
  console.log('tablist 内联列数:', inlineCols.trim() || '(未改写)')
  const colsOk = /repeat\(5/.test(inlineCols)

  // ---- 断言 2：人物卡片渲染（说明靠「原名/译名」匹配成功，页面里没有 h1~h3）----
  const cards = (detailBody.match(/class="vncp-card"/g) || []).length
  const diagShown = /class="vncp-diag"/.test(detailBody)
  console.log(`人物卡片数: ${cards} | 出现未匹配诊断行: ${diagShown}`)

  // ---- 断言 3：对话框里的「人物」行（且必须只出现一次、不复制原生字段）----
  const dialogDom = dumpDom(dialogFile)
  // 注入脚本自身的源码也在 dump 里，统计文案时必须先剥掉 <script>
  const dialogBody = dialogDom.replace(/<script[\s\S]*?<\/script>/g, '')
  const metaRow = dialogBody.indexOf('id="vncp-meta-row"') >= 0
  // ---- 断言 4：面板本身有内容、不是 0 高度空壳（详情页探针会自动点开「人物」）----
  const detailPanelTag = (detailBody.match(/id="vncp-panel"[^>]*>/) || [''])[0]
  const panelOk =
    /display:\s*block/.test(detailPanelTag) &&
    /min-height:\s*140px/.test(detailPanelTag) &&
    !/渲染异常/.test(detailBody)
  console.log('面板容器:', detailPanelTag.slice(0, 160) || '(未找到)')

  // ---- 断言 5：人物详情弹窗（点开卡片 → 全部字段 + 点图放大）----
  const modalHtml = (detailBody.match(/id="vncp-modal"[\s\S]*$/) || [''])[0]
  const modalOk = modalHtml.length > 0
  const modalHasAbout = /class="vncp-about"/.test(modalHtml)
  const modalHasFacts = (modalHtml.match(/class="vncp-fact"/g) || []).length
  const modalHasTraits = (modalHtml.match(/class="vncp-trait-group"/g) || []).length
  const modalHasZoom = /class="vncp-dialog-ava"/.test(modalHtml)
  console.log(
    `详情弹窗: 打开=${modalOk} 简介=${modalHasAbout} 资料项=${modalHasFacts} 特征分组=${modalHasTraits} 头像可点=${modalHasZoom}`
  )
  const modalAllOk = modalOk && modalHasAbout && modalHasFacts >= 3 && modalHasTraits >= 1 && modalHasZoom

  console.log('页面文件:', detailFile)
  console.log('        ', dialogFile)

  const shots = []
  for (const name of ['mock-detail', 'mock-dialog']) {
    const png = path.join(OUT, name + '.png')
    try {
      chrome([
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--virtual-time-budget=6000',
        '--window-size=1400,900',
        '--screenshot=' + png,
        'file:///' + path.join(OUT, name + '.html').replace(/\\/g, '/')
      ])
      shots.push(png)
    } catch (error) {
      console.log('截图失败:', name, String(error).slice(0, 160))
    }
  }
  if (shots.length) console.log('截图:', shots.join(' | '))

  // ---- 断言 5：非游戏详情页（「我的游戏记录」）不得注入 ----
  const recordsBody = dumpDom(recordsFile).replace(/<script[\s\S]*?<\/script>/g, '')
  const recordsTab = recordsBody.indexOf('id="vncp-tab"') >= 0
  const recordsPanel = recordsBody.indexOf('id="vncp-panel"') >= 0
  console.log(`记录页注入: 标签=${recordsTab} 面板=${recordsPanel}（期望都为 false）`)
  const recordsOk = !recordsTab && !recordsPanel

  // ---- 断言 6：侧边栏 h2「最近游戏」不得被当成作品名（线上 bug 回归）----
  const scrapeDom = dumpDom(scrapeFile)
  const titleMatch = scrapeDom.match(/<title>CAP:([\s\S]*?)(?:\|QUEUE:|<\/title>)/)
  // 拉取式通道：命令必须进 __VNCP_QUEUE__（console 通道在 Vnite 里不一定送达）
  const queueMatch = scrapeDom.match(/\|QUEUE:([^<]*)<\/title>/)
  let queueItems = []
  if (queueMatch) {
    try {
      queueItems = JSON.parse(decodeURIComponent(queueMatch[1]))
    } catch (error) {
      console.log('  ↳ 解析 __VNCP_QUEUE__ 失败:', String(error).slice(0, 120))
    }
  }
  const queueOk = queueItems.some((item) => item && item.cmd === 'scrape')
  let scrapeCandidates = []
  if (titleMatch) {
    try {
      const captured = JSON.parse(titleMatch[1])
      const entry = (captured || []).filter((line) =>
        String(line).startsWith('__VNCP:SCRAPE:')
      )[0]
      if (entry) {
        const raw = decodeURIComponent(String(entry).slice('__VNCP:SCRAPE:'.length))
        const parsed = JSON.parse(raw)
        // 0.6.1 起 marker 里带 { candidates, gameId }，兼容旧的纯数组
        scrapeCandidates = Array.isArray(parsed) ? parsed : parsed && parsed.candidates ? parsed.candidates : []
      }
    } catch (error) {
      console.log('  ↳ 解析 console 捕获失败:', String(error).slice(0, 120))
    }
  }
  const noSidebarLabel = scrapeCandidates.indexOf('最近游戏') < 0
  const hasGame = scrapeCandidates.some(
    (item) => String(item).includes('CLANNAD') || String(item).includes('クラナド')
  )
  console.log('刮削候选标题:', JSON.stringify(scrapeCandidates))
  console.log('队列命令:', JSON.stringify(queueItems))
  const scrapeOk = scrapeCandidates.length > 0 && noSidebarLabel && hasGame && queueOk
  if (!queueOk) console.log('  ↳ 命令没有进 __VNCP_QUEUE__：主进程拉取通道拿不到请求')
  if (!noSidebarLabel) console.log('  ↳ 侧边栏文案「最近游戏」被当成了作品名')
  if (!hasGame) console.log('  ↳ 候选里没有出现真正的作品名')

  // ---- 断言 7：空态/未匹配态仍给出「开始刮削」按钮 ----
  const emptyBody = dumpDom(emptyFile).replace(/<script[\s\S]*?<\/script>/g, '')
  const emptyBtn = /class="vncp-btn"/.test(emptyBody)
  console.log(`空态手动入口: 按钮=${emptyBtn}（期望 true）`)
  if (!emptyBtn) console.log('  ↳ 空态没有「开始刮削」按钮：用户没有自救路径')

  const hiddenDom = dumpDom(hiddenFile)
  const hiddenQueue = (hiddenDom.match(/QUEUE:([^"<]*)<\/title>/) || [])[1] || ''
  const hiddenCandidates = (() => {
    try {
      return JSON.parse(decodeURIComponent(hiddenQueue)).filter((item) => item && item.cmd === 'scrape')[0]
    } catch (error) {
      return null
    }
  })()
  const hiddenNames = (hiddenCandidates && hiddenCandidates.candidates) || []
  const hiddenOk =
    hiddenNames.indexOf('NOBLE☆WORKS') >= 0 && hiddenNames.indexOf('のーぶる☆わーくす') >= 0
  console.log('隐藏概览后的标题候选:', JSON.stringify(hiddenNames), hiddenOk ? '✓' : '✗')

  const switchDom = dumpDom(switchFile).replace(/<script[\s\S]*?<\/script>/g, '')
  const switchOk =
    switchDom.indexOf('兼元 灯里') >= 0 &&
    switchDom.indexOf('月山瀬 奈') >= 0 &&
    switchDom.indexOf('AAA_上一部作品的人物') < 0
  console.log(
    '切游戏后的人物来源: B 角色=' +
      (switchDom.indexOf('兼元 灯里') >= 0) +
      ' 泄漏 A 角色=' +
      (switchDom.indexOf('AAA_上一部作品的人物') >= 0) +
      (switchOk ? ' ✓' : ' ✗')
  )

  const mismatchBody = dumpDom(mismatchFile).replace(/<script[\s\S]*?<\/script>/g, '')
  const mismatchCards = (mismatchBody.match(/class="vncp-card"/g) || []).length
  const mismatchLeak = mismatchBody.indexOf('别的游戏的人物') >= 0
  const mismatchOk = mismatchCards === 0 && !mismatchLeak
  console.log(`错游戏保护: 卡片=${mismatchCards} 泄漏别家人物=${mismatchLeak}（期望 0 / false）`)

  const ok =
    recordsOk &&
    orderOk &&
    colsOk &&
    cards > 0 &&
    !diagShown &&
    panelOk &&
    scrapeOk &&
    emptyBtn &&
    figureOk &&
    routeOk &&
    dupeOk &&
    restoreOk
  console.log(
    '\n结论:',
    ok
      ? '✅ 标签顺序/行内布局/匹配/面板可见/标题候选/立绘/路由/去重/下划线 全部通过（0.8.0）'
      : '❌ 有断言未通过'
  )
  if (!ok) process.exitCode = 1

  await plugin.deactivate(api)
}

function head(extraCss) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Vnite mock</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;
         background:linear-gradient(160deg,#2a1c22,#1a1418 45%,#141018); color:#e7e9f0; }
  .app { display:flex; min-height:100vh; }
  .nav { width:220px; flex:0 0 auto; padding:14px; border-right:1px solid rgba(255,255,255,.08);
         font-size:12px; color:#9aa0ad; }
  .nav div { padding:5px 6px; border-radius:6px; }
  .nav div.on { background:rgba(255,255,255,.08); color:#e7e9f0; }
  .main { flex:1 1 auto; min-width:0; padding:22px 34px 40px; display:flex; gap:26px; }
  .content { flex:1 1 auto; min-width:0; }
  .side { width:250px; flex:0 0 auto; font-size:12.5px; color:#c8ccd6; }
  .side h3 { margin:0 0 10px; font-size:14px; color:#e7e9f0; }
  /* 故意用 4 列 grid：这正是「插入第 5 个标签会掉到第二行」的元凶形态 */
  .tabs { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:8px;
          border-bottom:1px solid rgba(255,255,255,.10); margin-bottom:18px; }
  .tab { position:relative; padding:10px 2px 12px; background:none; border:0; color:#9aa0ad;
         font-size:13.5px; cursor:pointer; font-family:inherit; }
  .tab[data-state="active"] { color:#fff; font-weight:600; }
  .tab[data-state="active"]::after { content:""; position:absolute; left:0; right:0; bottom:-1px;
         height:2px; border-radius:2px; background:linear-gradient(90deg,#ff7d9d,#93a4ff); }
  .panel { font-size:13px; line-height:1.9; color:#c8ccd6; }
  .info { margin-top:26px; border-top:1px dashed rgba(255,255,255,.14); padding-top:14px;
          font-size:12.5px; color:#c8ccd6; display:grid; grid-template-columns:90px 1fr; gap:8px 14px; }
  .info b { color:#8f96a5; font-weight:400; }
  .dialog { position:fixed; inset:0; display:flex; align-items:center; justify-content:center;
            background:rgba(0,0,0,.45); }
  .dlg { width:520px; border-radius:16px; background:#232029; padding:22px 26px 18px;
         border:1px solid rgba(255,255,255,.10); box-shadow:0 24px 60px rgba(0,0,0,.5); }
  .dlg h3 { margin:0 0 6px; font-size:16px; }
  .dlg p { margin:0 0 16px; font-size:11.5px; color:#8f96a5; }
  .fields { display:grid; grid-template-columns:1fr 1fr; gap:8px 30px; font-size:12.5px; }
  .fields label { display:flex; align-items:center; gap:7px; color:#cfd3dc; }
  /* Vnite 用的 Tailwind 原子类，mock 里给等价实现 */
  .grid { display:grid; }
  .grid-cols-2 { grid-template-columns:1fr 1fr; }
  .gap-2 { gap:8px; }
  .flex { display:flex; }
  .items-center { align-items:center; }
  .dlg .grid > label { font-size:12.5px; color:#cfd3dc; }
  .dlg .flex label { color:#cfd3dc; font-size:12.5px; }
  .dlg input[type=checkbox] { accent-color:#5b8cff; }
  .merge { margin:16px 0 6px; font-size:12.5px; color:#cfd3dc; }
  .merge span { display:block; font-size:11.5px; color:#8f96a5; margin-bottom:6px; }
  .merge select { background:#1b181f; color:#cfd3dc; border:1px solid rgba(255,255,255,.14);
                  border-radius:8px; padding:4px 8px; }
  .actions { display:flex; justify-content:flex-end; gap:10px; margin-top:20px; }
  .actions button { font-size:12px; padding:6px 14px; border-radius:8px; cursor:pointer;
                    border:1px solid rgba(255,255,255,.14); background:transparent; color:#cfd3dc; }
  .actions button.primary { background:#e7e9f0; color:#1b181f; border-color:transparent; font-weight:600; }
  ${extraCss || ''}
</style>
</head>
<body>`
}

function buildDetailHtml(bootstrap, dataJson) {
  return (
    head('') +
    `
<div class="app">
  <aside class="nav">
    <div class="on">CLANNAD | 克兰纳德</div>
    <div>思影</div>
    <div>GIRLS·BOOK·MAKER</div>
    <div>末世孤雄 Vol.3</div>
  </aside>
  <main class="main">
    <div class="content">
    <!-- 故意不放 h1~h3：验证「靠基本信息里的原名/译名匹配游戏」这条兜底路径 -->
    <div role="tablist" aria-label="game detail" class="tabs" aria-orientation="horizontal">
      <button role="tab" type="button" aria-selected="true" data-state="active" tabindex="0">概览</button>
      <button role="tab" type="button" aria-selected="false" data-state="inactive" tabindex="-1">记录</button>
      <button role="tab" type="button" aria-selected="false" data-state="inactive" tabindex="-1">存档</button>
      <button role="tab" type="button" aria-selected="false" data-state="inactive" tabindex="-1">回忆</button>
    </div>
    <div role="tabpanel" data-state="active" class="panel">
      <p>简介：在某个小镇，主角冈崎朋也因为家庭因素，过着堕落的生活。某一天，他在通往学校的坡道上遇到了一位少女——古河渚。</p>
    </div>
    </div>
    <aside class="side">
      <h3>基本信息</h3>
      <div class="info">
        <b>原名</b><span>クラナド</span>
        <b>译名</b><span>CLANNAD | 克兰纳德</span>
        <b>开发商</b><span>Key</span>
        <b>发行日期</b><span>2004-04-28</span>
      </div>
    </aside>
  </main>
</div>
<script>
  window.__VNCP_DATA__ = ${dataJson};
  window.__VNCP_STATUS__ = { kind: 'ok', text: '✅ 已更新（KunGalgame）：CLANNAD | 克兰纳德 · 共 51 人（深度补全 12 人）' };
  ${bootstrap}
  setTimeout(function () {
    var tab = document.getElementById('vncp-tab');
    if (tab) tab.click();
  }, 300);
  // 再点开第一张人物卡，验证详情弹窗（全部字段 + 图片放大）
  setTimeout(function () {
    var card = document.querySelector('#vncp-panel .vncp-card');
    if (card) card.click();
  }, 1200);
</script>
</body>
</html>`
  )
}

/**
 * 回归用例：缓存里只有「思影」的人物，但当前详情页是 NOBLE☆WORKS 且读不到基本信息。
 * 旧版会「只有一部作品就直接用它」，把思影的人物画到别的游戏页上。
 */
/**
 * 回归用例：基本信息放在「概览」tabpanel 里，切到「人物」后概览被 display:none。
 * innerText 在隐藏节点上返回空串，必须用 textContent 遍历 DOM 才能读到原名/译名。
 */
function buildHiddenPaneHtml(bootstrap, dataJson) {
  return (
    head('') +
    `
<div class="app">
  <aside class="nav">
    <h2 style="font-size:13px;margin:0 0 8px">最近游戏</h2>
    <div>思影</div>
  </aside>
  <main class="main">
    <div class="content">
      <div role="tablist" class="tabs" style="grid-template-columns:repeat(4,minmax(0,1fr))">
        <button role="tab" type="button" aria-selected="true" data-state="active">概览</button>
        <button role="tab" type="button" aria-selected="false" data-state="inactive">记录</button>
        <button role="tab" type="button" aria-selected="false" data-state="inactive">存档</button>
        <button role="tab" type="button" aria-selected="false" data-state="inactive">回忆</button>
      </div>
      <div role="tabpanel" data-state="active" class="panel">
        <p>简介：在某个小镇……</p>
        <div class="info">
          <div class="row"><div class="k">原名</div><div class="v">のーぶる☆わーくす</div></div>
          <div class="row"><div class="k">译名</div><div class="v">NOBLE☆WORKS</div></div>
          <div class="row"><div class="k">开发商</div><div class="v">ゆずソフト</div></div>
        </div>
      </div>
      <div role="tabpanel" data-state="inactive" class="panel"><p>记录</p></div>
    </div>
  </main>
</div>
<script>
  window.__VNCP_CAP__ = [];
  window.__VNCP_DATA__ = ${dataJson};
  window.__VNCP_STATUS__ = { kind: 'ok', text: '✅ 已更新（KunGalgame）：思影 · 共 1 人' };
  ${bootstrap}
  setTimeout(function () {
    var tab = document.getElementById('vncp-tab');
    if (tab) tab.click();
  }, 300);
  setTimeout(function () {
    var btn = document.querySelector('#vncp-panel .vncp-btn');
    if (btn) btn.click();
  }, 1200);
  setTimeout(function () {
    document.title = 'QUEUE:' + encodeURIComponent(JSON.stringify((window.__VNCP_QUEUE__ || []).map(function (c) {
      return { cmd: c.cmd, candidates: c.candidates || [] };
    })));
  }, 3000);
</script>
</body>
</html>`
  )
}

/**
 * 回归用例：同一窗口里先看过 A 的人物，再切到 B —— 面板必须换成 B 的名单。
 * 基本信息同样放在「概览」tabpanel 内（切到人物后被 display:none）。
 */
function buildSwitchHtml(bootstrap, dataJson) {
  return (
    head('') +
    `
<div class="app">
  <aside class="nav">
    <h2 style="font-size:13px;margin:0 0 8px">最近游戏</h2>
    <div>思影</div>
    <div>NOBLE☆WORKS</div>
  </aside>
  <main class="main">
    <div class="content">
      <div role="tablist" class="tabs" style="grid-template-columns:repeat(4,minmax(0,1fr))">
        <button role="tab" type="button" aria-selected="true" data-state="active">概览</button>
        <button role="tab" type="button" aria-selected="false" data-state="inactive">记录</button>
        <button role="tab" type="button" aria-selected="false" data-state="inactive">存档</button>
        <button role="tab" type="button" aria-selected="false" data-state="inactive">回忆</button>
      </div>
      <div role="tabpanel" data-state="active" class="panel">
        <div class="info" id="info">
          <div class="row"><div class="k">原名</div><div class="v" id="v-orig">思影</div></div>
          <div class="row"><div class="k">译名</div><div class="v" id="v-trans"></div></div>
        </div>
      </div>
      <div role="tabpanel" data-state="inactive" class="panel"><p>记录</p></div>
    </div>
  </main>
</div>
<script>
  window.__VNCP_DATA__ = ${dataJson};
  ${bootstrap}
  setTimeout(function () {
    var tab = document.getElementById('vncp-tab');
    if (tab) tab.click();
  }, 300);
  // 1.2s 后模拟「切到另一部游戏」：基本信息整体换掉（快照与版本号都不变）
  setTimeout(function () {
    document.getElementById('v-orig').textContent = 'のーぶる☆わーくす';
    document.getElementById('v-trans').textContent = 'NOBLE☆WORKS';
  }, 1200);

</script>
</body>
</html>`
  )
}

function buildMismatchHtml(bootstrap, dataJson) {
  return (
    head('') +
    `
<div class="app">
  <aside class="nav">
    <h2 style="font-size:13px;margin:0 0 8px">最近游戏</h2>
    <div>思影</div>
    <div>NOBLE☆WORKS</div>
  </aside>
  <main class="main">
    <div class="content">
    <div role="tablist" class="tabs">
      <button role="tab" type="button" aria-selected="true" data-state="active">概览</button>
      <button role="tab" type="button" aria-selected="false" data-state="inactive">记录</button>
      <button role="tab" type="button" aria-selected="false" data-state="inactive">存档</button>
      <button role="tab" type="button" aria-selected="false" data-state="inactive">回忆</button>
    </div>
    <div role="tabpanel" class="panel"><p>简介：……</p></div>
    </div>
  </main>
</div>
<script>
  window.__VNCP_DATA__ = ${dataJson};
  ${bootstrap}
  setTimeout(function () {
    var tab = document.getElementById('vncp-tab');
    if (tab) tab.click();
  }, 300);
</script>
</body>
</html>`
  )
}

function buildRecordsHtml(bootstrap, dataJson) {
  return (
    head('') +
    `
<div class="app">
  <aside class="nav"><div>CLANNAD | 克兰纳德</div><div>思影</div></aside>
  <main class="main">
    <h1 style="font-size:20px;margin:0 0 16px">我的游戏记录</h1>
    <!-- 真实 Vnite 的「我的游戏记录」页：总览 + 年报/月报/周报/评分报告/导出报告 -->
    <div role="tablist" class="tabs" style="grid-template-columns:repeat(6,minmax(0,1fr))">
      <button role="tab" type="button" aria-selected="true" data-state="active">总览</button>
      <button role="tab" type="button" aria-selected="false" data-state="inactive">年报</button>
      <button role="tab" type="button" aria-selected="false" data-state="inactive">月报</button>
      <button role="tab" type="button" aria-selected="false" data-state="inactive">周报</button>
      <button role="tab" type="button" aria-selected="false" data-state="inactive">评分报告</button>
      <button role="tab" type="button" aria-selected="false" data-state="inactive">导出报告</button>
    </div>
    <div role="tabpanel" class="panel"><p>游戏时间合计 202 小时。</p></div>
  </main>
</div>
<script>
  window.__VNCP_DATA__ = ${dataJson};
  ${bootstrap}
</script>
</body>
</html>`
  )
}

function buildDialogHtml(bootstrap, dataJson) {
  // 严格复刻 Vnite 4.15.0 的真实结构（来自 /out/renderer/assets/index-*.js）：
  //   div.grid.gap-2 > Label + div.grid.grid-cols-2.gap-2 > (div.flex.items-center.gap-2 > Checkbox#field-x + Label)
  // 旧版本探针用 <label> 平铺，掩盖了「克隆整个 grid 导致字段重复」的 bug
  const field = (id, name, checked) =>
    `<div class="flex items-center gap-2"><input type="checkbox" id="field-${id}"${checked ? ' checked' : ''}> <label for="field-${id}">${name}</label></div>`
  return (
    head('') +
    `
<div class="app">
  <aside class="nav"><div class="on">CLANNAD | 克兰纳德</div><div>思影</div></aside>
  <main class="main">
    <div role="tablist" class="tabs">
      <button role="tab" type="button" aria-selected="true" data-state="active">概览</button>
      <button role="tab" type="button" aria-selected="false" data-state="inactive">记录</button>
      <button role="tab" type="button" aria-selected="false" data-state="inactive">存档</button>
      <button role="tab" type="button" aria-selected="false" data-state="inactive">回忆</button>
    </div>
    <div role="tabpanel" class="panel"><p>简介：……</p></div>
    <div class="info"><b>原名</b><span>クラナド</span><b>译名</b><span>CLANNAD | 克兰纳德</span></div>
  </main>
</div>
<div class="dialog" role="dialog" aria-modal="true">
  <div class="dlg">
    <h3>更新游戏元数据</h3>
    <p>从选定的数据源获取游戏元数据并应用到游戏库中</p>
    <div class="grid gap-2">
      <label>要更新的字段</label>
      <div class="grid grid-cols-2 gap-2">
        ${field('all', '所有字段', true)}
        ${field('name', '名称', true)}
        ${field('releaseDate', '发行日期', true)}
        ${field('description', '描述', false)}
        ${field('developers', '开发商', true)}
        ${field('publishers', '发行商', true)}
        ${field('genres', '类型', true)}
        ${field('platforms', '平台', true)}
        ${field('tags', '标签', true)}
        ${field('relatedSites', '相关网站', true)}
        ${field('extra', '附加信息', true)}
        ${field('cover', '封面', false)}
        ${field('background', '背景', false)}
        ${field('logo', '徽标', false)}
      </div>
    </div>
    <div class="merge"><span>合并策略</span><select><option>替换</option><option>合并</option></select></div>
    <div class="actions"><button>取消</button><button class="primary">更新元数据</button></div>
  </div>
</div>
<script>
  window.__VNCP_DATA__ = ${dataJson};
  ${bootstrap}
</script>
</body>
</html>`
  )
}

/**
 * 复现线上 bug：左侧栏有 h2「最近游戏」、详情页没有 h1~h3、也没有「基本信息」，
 * 点「更新游戏元数据」里的「立即刮削」时，标题候选必须把界面文案挡掉。
 */
function buildScrapeHtml(bootstrap, dataJson) {
  // 0.8.0 起「更新游戏元数据」对话框里不再有人物入口（用户要求删掉），
  // 手动刮削只剩详情页面板里的「开始刮削」按钮 —— 点它来验证命令通道。
  return (
    head('') +
    `
<div class="app">
  <aside class="nav">
    <h2>最近游戏</h2>
    <div class="on">生肉(80.7h, 15)</div>
    <div>熟肉(121h, 12)</div>
    <h2>所有游戏</h2>
    <div>思影</div>
  </aside>
  <main class="main">
    <div class="content">
      <div role="tablist" class="tabs">
        <button role="tab" type="button" aria-selected="true" data-state="active">概览</button>
        <button role="tab" type="button" aria-selected="false" data-state="inactive">记录</button>
        <button role="tab" type="button" aria-selected="false" data-state="inactive">存档</button>
        <button role="tab" type="button" aria-selected="false" data-state="inactive">回忆</button>
      </div>
      <div role="tabpanel" class="panel"><div class="game-title">CLANNAD | 克兰纳德</div><p>简介：……</p></div>
    </div>
    <aside class="side">
      <h3>基本信息</h3>
      <div class="info">
        <b>原名</b><span>クラナド</span>
        <b>译名</b><span>CLANNAD | 克兰纳德</span>
        <b>排序名称</b><span>暂无</span>
      </div>
    </aside>
  </main>
</div>
<script>
  window.__VNCP_CAP__ = [];
  const __info = console.info.bind(console);
  console.info = function () {
    try { window.__VNCP_CAP__.push(Array.prototype.slice.call(arguments).join(' ')); } catch (e) {}
    return __info.apply(console, arguments);
  };
  window.__VNCP_DATA__ = ${JSON.stringify({ v: 1, label: '', games: [] })};
  ${bootstrap}
  setTimeout(function () {
    var tab = document.getElementById('vncp-tab');
    if (tab) tab.click();
  }, 600);
  function clickScrape() {
    var buttons = document.querySelectorAll('.vncp-btn');
    for (var i = 0; i < buttons.length; i++) {
      var label = (buttons[i].textContent || '').trim();
      if (label.indexOf('刮削') >= 0 && !buttons[i].disabled) {
        buttons[i].click();
        return true;
      }
    }
    return false;
  }
  [1500, 2400, 3300].forEach(function (delay) {
    setTimeout(clickScrape, delay);
  });
  setTimeout(function () {
    document.title =
      'CAP:' + JSON.stringify(window.__VNCP_CAP__) +
      '|QUEUE:' + encodeURIComponent(JSON.stringify(window.__VNCP_QUEUE__ || []));
  }, 5200);
</script>
</body>
</html>`
  )
}

main().catch((error) => {
  console.error('探针失败:', error)
  process.exitCode = 1
})
