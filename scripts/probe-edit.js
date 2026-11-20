/**
 * 右键菜单 / 编辑弹窗探针（本地验证，不进包）。
 *
 * 用 BOOTSTRAP_SOURCE（dist/index.js 里序列化的注入脚本）造一份仿 Vnite 详情页，
 * 页内脚本自动完成：插标签 → 点标签 → 右键卡片 → 点「编辑这个人的资料…」→ 改名 → 提交
 * → 再右键 → 点「从本作人物栏删除」→ 读出 __VNCP_QUEUE__ 里的命令；
 * 最后模拟主进程「叠加 overrides 后重新下发」，断言卡片数量变化。
 *
 * 断言结果写进 <pre id="probe-out">，用 --dump-dom 取回。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const pluginModule = require('../dist/index.js')
const { BOOTSTRAP_SOURCE } = pluginModule

const OUT = path.resolve(__dirname, '..', '.tmp', 'edit')
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
fs.mkdirSync(OUT, { recursive: true })

const GAME = {
  id: 'g-editor',
  names: ['右键测试作品', '右クリックテスト'],
  workName: '右键测试作品',
  total: 3,
  enriched: 1,
  source: 'kungal',
  workId: '886',
  fetchedAt: Date.now(),
  characters: [
    {
      id: '26441',
      n: '姫野原 鈴蘭',
      o: 'Himenohara Suzuran',
      role: '主角',
      cv: '榊るな',
      img: '',
      intro: '见钟情，并跟踪他的同班同学。',
      about: '',
      facts: [
        { k: '性别', v: '女' },
        { k: '生日', v: '06-01' },
        { k: '身高', v: '160cm' },
        { k: '三围', v: 'B86/W57/H82' }
      ],
      traits: [],
      aliases: ['姫野原鈴蘭'],
      links: []
    },
    { id: '26440', n: '白檀 翠', role: '其他', cv: '吉川ナガレ', facts: [], traits: [], aliases: [], links: [] },
    { id: '81083', n: '志木 春臣', role: '主角', cv: '', facts: [], traits: [], aliases: [], links: [] }
  ]
}

const DATA = { label: '', games: [GAME] }

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>vncp edit probe</title>
<style>
 body{margin:0;background:#1b1d23;color:#e7e9f0;font:14px/1.6 "Microsoft YaHei",system-ui,sans-serif;}
 .tabs{display:flex;gap:8px;padding:12px;}
 .tabs button{flex:1 1 0;min-width:0;padding:8px;background:#2a2d36;color:#e7e9f0;border:0;border-radius:6px;font:inherit;}
 .head{padding:8px 16px;font-size:20px;}
</style></head><body>
<div class="head">右键测试作品</div>
<div class="info" role="tabpanel" id="pane-info">
  <div><b>原名</b><span>右クリックテスト</span></div>
  <div><b>译名</b><span>右键测试作品</span></div>
</div>
<div class="tabs" role="tablist">
  <button role="tab" data-state="active" aria-selected="true">概览</button>
  <button role="tab" data-state="inactive" aria-selected="false">记录</button>
  <button role="tab" data-state="inactive" aria-selected="false">存档</button>
  <button role="tab" data-state="inactive" aria-selected="false">回忆</button>
</div>
<div role="tabpanel" id="pane-overview">右键测试作品</div>
<div role="tabpanel" id="pane-record" style="display:none">记录</div>
<div role="tabpanel" id="pane-save" style="display:none">存档</div>
<div role="tabpanel" id="pane-memory" style="display:none">回忆</div>
<pre id="probe-out">PENDING</pre>
<script>try{location.hash = '#/library/games/g-editor/group-1'}catch(e){}; window.__VNCP_DATA__ = ${JSON.stringify(DATA)}; window.__VNCP_QUEUE__ = [];</script>
<script>${BOOTSTRAP_SOURCE}</script>
<script>
(async function () {
  const out = []
  try {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = () => (window.__VNCP_QUEUE__ || [])
  const last = () => q()[q().length - 1] || null
  const cards = () => document.querySelectorAll('#vncp-panel .vncp-card')

  await wait(900)
  const tab = document.getElementById('vncp-tab')
  out.push('标签注入=' + !!tab)
  if (tab) { tab.click(); await wait(200) }
  out.push('卡片数量=' + cards().length)

  // ---- 右键菜单 ----
  const first = cards()[0]
  first.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 320, clientY: 260 }))
  await wait(80)
  const menu = document.getElementById('vncp-menu')
  out.push('右键出现菜单=' + !!menu + ' 菜单项=' + (menu ? menu.children.length : 0))
  out.push('菜单文案=' + (menu ? Array.from(menu.children).map((n) => n.textContent).join('|') : ''))

  // SHOT_ONLY=1 时停在「菜单/弹窗打开」的状态，方便截图
  if (window.__VNCP_SHOT__) {
    if (window.__VNCP_SHOT__ === 'editor' && menu && menu.children[0]) {
      menu.children[0].click()
      await wait(200)
    }
    document.getElementById('probe-out').textContent = 'RESULT 截图模式'
    return
  }

  // ---- 编辑：改名 + 改简介 ----
  let modal = null
  if (menu && menu.children[0]) {
    menu.children[0].click()
    await wait(120)
    modal = document.getElementById('vncp-modal')
    out.push('编辑弹窗=' + !!modal + ' 输入框数=' + (modal ? modal.querySelectorAll('input,textarea').length : 0))
    if (modal) {
      const fields = modal.querySelectorAll('.vncp-field')
      const nameInput = fields[0].querySelector('input')
      out.push('名字预填=' + nameInput.value)
      nameInput.value = '姫野原 鈴蘭（改）'
      const ta = modal.querySelector('textarea')
      if (ta) ta.value = '';
      modal.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await wait(120)
      const cmd = last()
      out.push('编辑命令=' + (cmd && cmd.cmd) + ' gameId=' + (cmd && cmd.gameId) + ' id=' + (cmd && cmd.id))
      out.push('编辑内容=' + (cmd && cmd.patch ? JSON.stringify({ name: cmd.patch.name, birthday: cmd.patch.birthday }) : '无'))
      out.push('编辑后弹窗已关=' + !document.getElementById('vncp-modal'))
    }
  }

  // ---- 删除 ----
  const again = cards()[0]
  again.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }))
  await wait(80)
  const menu2 = document.getElementById('vncp-menu')
  if (menu2 && menu2.children[menu2.children.length - 1]) {
    menu2.children[menu2.children.length - 1].click()
    await wait(120)
    const cmd = last()
    out.push('删除命令=' + (cmd && cmd.cmd) + ' gameId=' + (cmd && cmd.gameId) + ' id=' + (cmd && cmd.id) + ' name=' + (cmd && cmd.name))
    out.push('删除后菜单已关=' + !document.getElementById('vncp-menu'))
  } else {
    out.push('删除命令=没有第二项')
  }

  // ---- 模拟主进程叠加 overrides 后重新下发（删掉第一张卡） ----
  const before = cards().length
  window.__VNCP_DATA__.games[0].characters = window.__VNCP_DATA__.games[0].characters.slice(1)
  window.__VNCP_DATA__.games[0].total = 2
  window.__VNCP_KEY__ = ''
  if (typeof window.__VNCP_RENDER__ === 'function') window.__VNCP_RENDER__()
  await wait(300)
  out.push('重新下发后卡片数=' + before + '→' + cards().length)

  } catch (error) {
    out.push('EXCEPTION ' + (error && error.message))
  }
  document.getElementById('probe-out').textContent = 'RESULT ' + out.join('\\nRESULT ')
})()
</script>
</body></html>`

const htmlPath = path.join(OUT, 'page.html')
fs.writeFileSync(htmlPath, html, 'utf8')

function chrome(args) {
  return execFileSync(CHROME, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

const url = 'file:///' + htmlPath.replace(/\\/g, '/')
const dom = chrome(['--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=1400,900', '--virtual-time-budget=8000', '--dump-dom', url])
const png = path.join(OUT, 'shot.png')
chrome(['--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=1400,900', '--virtual-time-budget=8000', '--screenshot=' + png, url])

const lines = dom.split('\n').filter((line) => line.includes('RESULT '))
const text = lines.join('\n').replace(/<[^>]+>/g, '').trim()
console.log(text || '没有拿到结果')

const checks = [
  ['标签注入', /标签注入=true/],
  ['卡片数量=3', /卡片数量=3/],
  ['右键出现菜单=2 项', /右键出现菜单=true 菜单项=4/],
  ['菜单文案含编辑与删除', /编辑这个人的资料[\s\S]*从本作人物栏删除/],
  ['编辑弹窗=13 个字段', /编辑弹窗=true 输入框数=13/],
  ['名字预填', /名字预填=姫野原 鈴蘭/],
  ['编辑命令 edit-char', /编辑命令=edit-char gameId=g-editor id=26441/],
  ['编辑内容带了名字', /编辑内容=\{"name":"姫野原 鈴蘭（改）"/],
  ['编辑后弹窗已关', /编辑后弹窗已关=true/],
  ['删除命令 remove-char', /删除命令=remove-char gameId=g-editor id=26441/],
  ['重新下发后剩 2 张卡', /重新下发后卡片数=3→2/]
]

let failed = 0
for (const [name, re] of checks) {
  const ok = re.test(text)
  if (!ok) failed++
  console.log((ok ? '✅ ' : '❌ ') + name)
}
console.log(failed === 0 ? '🎉 右键/编辑探针全部通过' : '⚠️ 有 ' + failed + ' 项没通过')
if (failed) process.exitCode = 1
