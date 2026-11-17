/**
 * 真实数据渲染验证（v0.8.7）：抓 KunGalgame 的 #886 / #1626，把真实快照塞进
 * 仿 Vnite 详情页的 harness 里，截两张图对比：
 *   - 同一系列两作人数不同（7 / 8），标题旁的 `KunGalgame #886` / `#1626` 徽章不同；
 *   - 每部作品内没有同名重复卡片（合并条数写在状态行）。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const pluginModule = require('../dist/index.js')
const plugin = pluginModule.default || pluginModule
const { NativeTabInjector, BOOTSTRAP_SOURCE } = pluginModule

const OUT = path.join(__dirname, '..', '.tmp', 'real')
fs.mkdirSync(OUT, { recursive: true })

const GAMES = {
  'game-886': { name: '女友×女友×女友  与三姐妹的精彩共同生活', original: '彼女×彼女×彼女～三姉妹とのドキドキ共同生活～' },
  'game-1626': { name: '女友×女友×女友　心跳 全油门！', original: '彼女×彼女×彼女　ドキドキ フルスロットル！' }
}

const kv = new Map()
const docs = {}
for (const [id, meta] of Object.entries(GAMES)) {
  docs[id] = { _id: id, metadata: { name: meta.name, originalName: meta.original } }
}

const api = {
  pluginId: 'character-atlas',
  PluginDB: {
    getValue: async (key, def) => (kv.has(key) ? kv.get(key) : def),
    setValue: async (key, value) => void kv.set(key, value)
  },
  ConfigDB: { getConfigValue: async () => undefined, setConfigValue: async () => {} },
  GameDB: {
    getGame: async (id) => (docs[id] ? JSON.parse(JSON.stringify(docs[id])) : null),
    getAllGames: async () => Object.fromEntries(Object.keys(docs).map((id) => [id, { _id: id }])),
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

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
].find((candidate) => fs.existsSync(candidate))

function head() {
  return `<!doctype html>
<html lang="zh-Hans"><head><meta charset="utf-8">
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #1a1620; color: #ece8f2; font: 15px/1.6 "Microsoft YaHei", system-ui, sans-serif; }
  .app { display: flex; min-height: 100vh; }
  .nav { width: 200px; background: #14111a; padding: 16px 12px; font-size: 13px; color: #a89fb8; }
  .nav .on { color: #fff; background: #2a2434; border-radius: 6px; padding: 4px 8px; }
  .main { flex: 1; padding: 22px 28px; }
  .tabs { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; margin-bottom: 14px; }
  .tabs button { font: inherit; padding: 8px 0; background: #221c2b; color: #cfc7db; border: 0; border-radius: 4px; }
  .tabs button[data-state="active"] { background: #f2eef8; color: #1a1620; }
  .side { width: 240px; padding: 16px; font-size: 13px; color: #b6adc4; }
  .side b { display: inline-block; width: 62px; color: #8b8299; font-weight: 400; }
  .side span { color: #e6e1ee; }
  .side h3 { font-size: 14px; color: #fff; margin: 0 0 8px; }
</style></head><body>`
}

function page(snapshot, meta) {
  const status = snapshot.games[0]
    ? `✅ 已更新（KunGalgame）：${snapshot.games[0].workName} · 共 ${snapshot.games[0].total} 人`
    : ''
  return (
    head() +
    `
<div class="app">
  <aside class="nav"><div class="on">女友×女友×女友</div><div>思影</div><div>CLANNAD</div></aside>
  <main class="main">
    <div role="tablist" class="tabs" aria-orientation="horizontal">
      <button role="tab" type="button" aria-selected="true" data-state="active">概览</button>
      <button role="tab" type="button" aria-selected="false" data-state="inactive">记录</button>
      <button role="tab" type="button" aria-selected="false" data-state="inactive">存档</button>
      <button role="tab" type="button" aria-selected="false" data-state="inactive">回忆</button>
    </div>
    <div role="tabpanel" data-state="active" style="display:none"></div>
  </main>
  <aside class="side">
    <h3>基本信息</h3>
    <div><b>原名</b><span>${meta.original}</span></div>
    <div><b>译名</b><span>${meta.name}</span></div>
  </aside>
</div>
<script>
  window.__VNCP_DATA__ = ${JSON.stringify(snapshot)};
  window.__VNCP_STATUS__ = { kind: 'ok', text: ${JSON.stringify(status)} };
  ${BOOTSTRAP_SOURCE}
  setTimeout(function () {
    var tab = document.getElementById('vncp-tab');
    if (tab) tab.click();
  }, 250);
</script>
</body></html>`
  )
}

function shoot(htmlPath, pngPath, height) {
  if (!CHROME) {
    console.log('（找不到 Chrome，跳过截图）')
    return
  }
  execFileSync(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=1400,${height}`,
    `--screenshot=${path.resolve(pngPath)}`,
    '--virtual-time-budget=4000',
    path.resolve(htmlPath)
  ], { stdio: 'ignore' })
  console.log('📸', pngPath)
}

;(async () => {
  await plugin.activate(api)
  const service = api.__characterPanelService
  service.updateConfig({ ...service.config, maxCharacters: 20, localImages: false, vndbFallback: false })
  const injector = new NativeTabInjector({ maxCharacters: 80, introLimit: 320 })
  injector.start()

  for (const gameId of Object.keys(GAMES)) {
    const panel = await service.scrapeAndStore(gameId)
    await injector.setGame(gameId, [GAMES[gameId].name, GAMES[gameId].original], panel)
    console.log(`${gameId} → #${panel.workId} ${panel.total} 人（合并 ${panel.duplicates} 条）`)
  }

  for (const gameId of Object.keys(GAMES)) {
    const snapshot = injector.snapshot()
    const one = { v: snapshot.v, label: snapshot.label, games: snapshot.games.filter((game) => game.id === gameId) }
    const htmlPath = path.join(OUT, `${gameId}.html`)
    fs.writeFileSync(htmlPath, page(one, GAMES[gameId]), 'utf8')
    shoot(htmlPath, path.join(OUT, `${gameId}.png`), 1000)
  }
  injector.stop()
  await plugin.deactivate?.(api)
})().catch((error) => {
  console.error('失败:', error)
  process.exit(1)
})
