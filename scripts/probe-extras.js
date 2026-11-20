/**
 * 1.2.0 六项功能的 DOM 探针（本地验证，不进包）。
 *
 * 用 BOOTSTRAP_SOURCE 造一份仿 Vnite 详情页，并伪造 preload 的
 * `window.electron.ipcRenderer.invoke`，逐项断言：
 *   1. 右键菜单有四项（编辑 / 换成本地图片 / 保存人物卡图片 / 删除）；
 *   2. 快捷键：列表页 `/` 聚焦搜索（方向键不再选卡）；详情弹窗内 ←/→ 换人、E 编辑、S 出图、T 剧透、Esc 关闭；
 *   3. 详情弹窗「保存成图片」→ 走 character-atlas:save-image，并回写状态；
 *   4. 详情弹窗「登场作品」→ 走 character-atlas:appearances，渲染成可点行；
 *   5. 换图流程 pick-image → set-image 两次 invoke 都发出去了。
 *
 *   node scripts/probe-extras.js
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const pluginModule = require('../dist/index.js')
const { BOOTSTRAP_SOURCE } = pluginModule

const OUT = path.resolve(__dirname, '..', '.tmp', 'extras')
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
fs.mkdirSync(OUT, { recursive: true })

const DATA = {
  v: 901,
  label: '',
  games: [
    {
      id: 'g-extras',
      names: ['功能测试作品', 'エクストラテスト'],
      workName: '功能测试作品',
      workId: '42',
      source: 'kungal',
      total: 2,
      enriched: 2,
      fetchedAt: Date.now(),
      characters: [
        {
          id: 'c1',
          n: '本多 世枝瑠',
          o: 'Honda Cécile',
          alt: '本多世枝瑠',
          role: '主角',
          cv: '榊木春乃',
          img: '',
          meta: '女 · 143cm',
          intro: '零没有血缘关系的妹妹。',
          about: '零没有血缘关系的妹妹。其实是一直喜欢哥哥的那个人。',
          traits: [{ g: '角色身份', n: '妹妹' }, { g: '角色身份', n: '实妹', sp: 'major' }],
          chips: ['妹妹'],
          facts: [{ k: '身高', v: '143cm' }]
        },
        {
          id: 'c2',
          n: '藤林 椋',
          role: '配角',
          img: '',
          intro: '内向的妹妹。',
          traits: [{ g: '性格', n: '内向' }],
          chips: ['内向']
        }
      ]
    }
  ]
}

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>probe-extras</title>
<style>
  body{margin:0;background:#15161a;color:#e7e9f0;font-family:"Microsoft YaHei",system-ui,sans-serif}
  .tabs{display:flex;gap:8px;padding:12px}
  .head{padding:8px 16px;font-size:20px}
  .info{padding:0 16px 8px;font-size:13px;color:#9aa}
  [role="tab"]{padding:6px 14px;background:transparent;color:#bbb;border:1px solid transparent;border-radius:8px;cursor:pointer}
</style></head><body>
<div class="head">功能测试作品</div>
<div class="info" role="tabpanel" id="pane-info">
  <div><b>原名</b><span>エクストラテスト</span></div>
  <div><b>译名</b><span>功能测试作品</span></div>
</div>
<div class="tabs" role="tablist">
  <button role="tab" data-state="active" aria-selected="true">概览</button>
  <button role="tab" data-state="inactive" aria-selected="false">记录</button>
  <button role="tab" data-state="inactive" aria-selected="false">存档</button>
  <button role="tab" data-state="inactive" aria-selected="false">回忆</button>
</div>
<div role="tabpanel" id="pane-overview">功能测试作品</div>
<div role="tabpanel" id="pane-record" style="display:none">记录</div>
<div role="tabpanel" id="pane-save" style="display:none">存档</div>
<div role="tabpanel" id="pane-memory" style="display:none">回忆</div>
<pre id="probe-out">PENDING</pre>
<div id="card-dump" style="display:none"></div>
<script>
  // 伪造 preload 暴露的 ipcRenderer.invoke：记录调用，按通道返回假数据
  window.__CALLS = [];
  window.electron = {
    ipcRenderer: {
      send: function (channel, payload) { window.__CALLS.push({ channel: channel, payload: payload, kind: 'send' }) },
      invoke: function (channel, payload) {
        window.__CALLS.push({ channel: channel, payload: payload, kind: 'invoke' })
        if (channel === 'character-atlas:appearances') {
          return Promise.resolve({ ok: true, items: [
            { id: '86', title: 'CLANNAD', role: '主角', url: '' },
            { id: '90', title: '另一部作品', role: '登场', url: 'https://example.com/w/90' }
          ] })
        }
        if (channel === 'character-atlas:save-image') return Promise.resolve({ ok: true, path: 'D:/tmp/card.png' })
        if (channel === 'character-atlas:pick-image') return Promise.resolve({ ok: true, path: 'D:/tmp/pick.png' })
        if (channel === 'character-atlas:set-image') return Promise.resolve({ ok: true, path: 'D:/tmp/stored.png' })
        if (channel === 'character-atlas:stats') return Promise.resolve({ ok: true, games: 1, characters: 2, images: 3, imageSize: '12.3 KB', dir: 'D:/db/character-atlas/images', oldest: '2026-11-01 10:00', newest: '2026-11-17 20:00', ttlHours: 720 })
        if (channel === 'character-atlas:image') return Promise.resolve(null)
        return Promise.resolve(null)
      }
    }
  }
  try{location.hash = '#/library/games/g-extras/group-1'}catch(e){}
  window.__VNCP_DATA__ = ${JSON.stringify(DATA)};
  window.__VNCP_QUEUE__ = [];
</script>
<script>${BOOTSTRAP_SOURCE}</script>
<script>
(async function () {
  const out = []
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const key = (name, extra) => {
    const event = new KeyboardEvent('keydown', Object.assign({ key: name, bubbles: true, cancelable: true }, extra || {}))
    document.body.dispatchEvent(event)
    return event
  }
  const menuLabels = () => Array.from(document.querySelectorAll('#vncp-menu .vncp-menu-item')).map((n) => n.textContent)
  try {
    await wait(900)
    const tab = document.getElementById('vncp-tab')
    out.push('标签注入=' + !!tab)
    if (tab) { tab.click(); await wait(250) }

    const cards = Array.from(document.querySelectorAll('#vncp-panel .vncp-card'))
    out.push('卡片数=' + cards.length)

    // 1) 右键菜单
    cards[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 160 }))
    await wait(150)
    out.push('右键菜单=' + menuLabels().join('|'))
    // 关掉菜单
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await wait(120)
    out.push('菜单已关=' + !document.getElementById('vncp-menu'))

    // 2) 列表页：只有 / 聚焦搜索，方向键不再选卡
    key('/')
    await wait(120)
    const search = document.querySelector('#vncp-panel .vncp-search')
    out.push('斜杠聚焦搜索=' + (search ? document.activeElement === search : 'n/a'))
    if (search) search.blur()
    key('ArrowRight')
    await wait(150)
    out.push('列表页方向键不选卡=' + document.querySelectorAll('#vncp-panel .vncp-card[data-sel="1"]').length)

    // 3) 点卡片打开详情
    document.querySelectorAll('#vncp-panel .vncp-card')[0].click()
    await wait(350)
    out.push('点卡片打开详情=' + !!document.getElementById('vncp-modal'))
    out.push('详情标题=' + ((document.querySelector('.vncp-dialog-title') || {}).textContent || ''))

    // 4) 登场作品
    const appear = Array.from(document.querySelectorAll('.vncp-appear-row'))
    out.push('登场作品行=' + appear.map((n) => n.textContent).join('|'))
    out.push('可点行数=' + appear.filter((n) => n.getAttribute('data-link') === '1').length)

    // 5) 详情内 ←/→ 换人
    key('ArrowRight')
    await wait(350)
    out.push('右方向换到=' + ((document.querySelector('.vncp-dialog-title') || {}).textContent || ''))
    key('ArrowLeft')
    await wait(350)
    out.push('左方向回到=' + ((document.querySelector('.vncp-dialog-title') || {}).textContent || ''))

    // 6) S 出图（此时剧透默认收起）
    const shot = Array.from(document.querySelectorAll('.vncp-dialog-actions .vncp-act')).filter((n) => n.textContent.indexOf('保存成图片') >= 0)[0]
    out.push('出图按钮=' + (shot ? shot.textContent : '无'))
    const toggleText = () => ((document.querySelector('#vncp-modal .vncp-trait-toggle') || {}).textContent || '无')
    out.push('T 前=' + toggleText())
    key('s')
    await wait(700)
    const calls = window.__CALLS.filter((c) => c.channel === 'character-atlas:save-image')
    const firstShot = calls[0] && calls[0].payload ? String(calls[0].payload.dataUrl) : ''
    out.push('S 出图调用=' + calls.length)
    out.push('save-image 名字=' + (calls[0] && calls[0].payload ? calls[0].payload.name : 'n/a'))
    out.push('save-image 是 PNG=' + (firstShot.indexOf('data:image/png;base64,') === 0))
    const status = document.querySelector('#vncp-panel .vncp-status')
    out.push('状态栏=' + (status ? status.textContent : '无'))

    // 7) T 展开剧透后再出图：剧透标签应当跟着进图
    key('t')
    await wait(250)
    out.push('T 后=' + toggleText())
    out.push('展开后 data-open=' + ((document.querySelector('#vncp-modal .vncp-trait-toggle') || {}).getAttribute ? document.querySelector('#vncp-modal .vncp-trait-toggle').getAttribute('data-open') : '无'))
    key('s')
    await wait(800)
    const calls2 = window.__CALLS.filter((c) => c.channel === 'character-atlas:save-image')
    const secondShot = calls2[1] && calls2[1].payload ? String(calls2[1].payload.dataUrl) : ''
    out.push('两次出图长度=' + firstShot.length + '/' + secondShot.length)
    out.push('剧透开关影响出图=' + (firstShot.length !== secondShot.length && secondShot.length > 0))
    document.getElementById('card-dump').textContent = firstShot + '||' + secondShot

    // 8) E 打开编辑，Esc 关掉
    key('e')
    await wait(350)
    out.push('E 打开编辑=' + !!document.querySelector('#vncp-modal .vncp-form'))
    key('Escape')
    await wait(250)
    out.push('Esc 关闭详情=' + !document.getElementById('vncp-modal'))

    // 7) 换图流程：右键 → 换成本地图片
    const first = document.querySelector('#vncp-panel .vncp-card')
    first.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 140, clientY: 180 }))
    await wait(150)
    const swap = Array.from(document.querySelectorAll('#vncp-menu .vncp-menu-item')).filter((n) => n.textContent.indexOf('换成本地图片') >= 0)[0]
    out.push('换图菜单项=' + !!swap)
    if (swap) {
      swap.click()
      await wait(700)
      out.push('pick-image 调用=' + window.__CALLS.filter((c) => c.channel === 'character-atlas:pick-image').length)
      out.push('set-image 调用=' + window.__CALLS.filter((c) => c.channel === 'character-atlas:set-image').length)
      const sent = window.__CALLS.filter((c) => c.channel === 'character-atlas:set-image')[0]
      out.push('set-image 载荷=' + (sent && sent.payload ? [sent.payload.gameId, sent.payload.charId, String(sent.payload.filePath)].join(' / ') : 'n/a'))
    }
  } catch (error) {
    out.push('EXCEPTION ' + (error && error.message))
  }
  document.getElementById('probe-out').textContent = 'RESULT ' + out.join('\\nRESULT ')
})()
</script>
</body></html>`

const htmlPath = path.join(OUT, 'page.html')
fs.writeFileSync(htmlPath, html, 'utf8')

const url = 'file:///' + htmlPath.replace(/\\/g, '/')
function chrome(args) {
  return execFileSync(CHROME, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

const dom = chrome(['--headless=new', '--disable-gpu', '--window-size=1500,950', '--virtual-time-budget=12000', '--dump-dom', url])
const dumpMatch = /<div id="card-dump"[^>]*>([^<]*)<\/div>/.exec(dom)
if (dumpMatch && dumpMatch[1]) {
  const [closed, opened] = dumpMatch[1].split('||')
  const write = (dataUrl, name) => {
    const base64 = String(dataUrl || '').split(',')[1]
    if (!base64) return null
    const file = path.join(OUT, name)
    fs.writeFileSync(file, Buffer.from(base64, 'base64'))
    return file
  }
  const a = write(closed, 'card-closed.png')
  const b = write(opened, 'card-open.png')
  if (a) console.log('人物卡（未展开剧透）: ' + a)
  if (b) console.log('人物卡（展开剧透）: ' + b)
}

const png = path.join(OUT, 'extras.png')
chrome(['--headless=new', '--disable-gpu', '--window-size=1500,950', '--virtual-time-budget=12000', '--screenshot=' + png, url])

const text = dom
  .split('\n')
  .filter((line) => line.includes('RESULT '))
  .join('\n')
  .replace(/<[^>]+>/g, '')
  .trim()
console.log(text || '没有拿到结果')

const checks = [
  ['标签注入', /标签注入=true/],
  ['两张卡片', /卡片数=2/],
  ['右键菜单四项', /右键菜单=编辑这个人的资料…\|换成本地图片…\|保存人物卡图片…\|从本作人物栏删除/],
  ['点空白处关菜单', /菜单已关=true/],
  ['斜杠聚焦搜索框', /斜杠聚焦搜索=true/],
  ['列表页方向键不再选卡', /列表页方向键不选卡=0/],
  ['点卡片打开详情', /点卡片打开详情=true/],
  ['详情标题正确', /详情标题=本多 世枝瑠/],
  ['右方向换到下一个角色', /右方向换到=藤林 椋/],
  ['左方向回到上一个角色', /左方向回到=本多 世枝瑠/],
  ['T 前是显示剧透', /T 前=显示剧透（1）/],
  ['T 后就地展开', /T 后=收起剧透（1）/],
  ['登场作品渲染两行', /登场作品行=CLANNAD主角\|另一部作品登场/],
  ['只有带链接的行可点', /可点行数=1/],
  ['出图按钮存在', /出图按钮=保存成图片/],
  ['S 键出图走 save-image', /S 出图调用=1/],
  ['出图文件名叫人物名', /save-image 名字=本多 世枝瑠.png/],
  ['出图是 PNG dataURL', /save-image 是 PNG=true/],
  ['E 键打开编辑弹窗', /E 打开编辑=true/],
  ['状态栏提示已保存', /状态栏=✅ 已保存人物卡：D:\/tmp\/card.png/],
  ['剧透开关影响出图内容', /剧透开关影响出图=true/],
  ['Esc 关闭详情', /Esc 关闭详情=true/],
  ['换图菜单项存在', /换图菜单项=true/],
  ['换图走 pick-image', /pick-image 调用=1/],
  ['换图走 set-image', /set-image 调用=1/],
  ['换图载荷带 gameId/charId/路径', /set-image 载荷=g-extras \/ c1 \/ D:\/tmp\/pick.png/]
]

let bad = 0
for (const [name, re] of checks) {
  if (re.test(text)) console.log('✅ ' + name)
  else {
    bad++
    console.log('❌ ' + name)
  }
}
console.log(bad === 0 ? '\n✅ 快捷键 / 右键换图 / 人物卡出图 / 登场作品 全部通过' : `\n❌ ${bad} 项未通过`)
console.log('截图:', png)
process.exit(bad === 0 ? 0 : 1)
