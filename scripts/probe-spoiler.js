/**
 * 剧透开关探针（本地验证，不进包）。
 *
 * 用 BOOTSTRAP_SOURCE 造一份仿 Vnite 详情页，断言：
 *   1. 卡片上的小标签只要「无剧透」的（实妹 / 青梅竹马 不该出现）；
 *   2. 详情弹窗里默认只显示无剧透标签，剧透标签在折叠区里（display:none）；
 *   3. 有「显示剧透（N）」按钮，点一下展开、再点收起，data-open 同步。
 *
 *   node scripts/probe-spoiler.js
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const pluginModule = require('../dist/index.js')
const { BOOTSTRAP_SOURCE } = pluginModule

const OUT = path.resolve(__dirname, '..', '.tmp', 'spoiler')
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
fs.mkdirSync(OUT, { recursive: true })

const DATA = {
  v: 780,
  label: '',
  games: [
    {
      id: 'g-spoil',
      names: ['剧透测试作品', 'スポイルテスト'],
      workName: '剧透测试作品',
      workId: '999',
      source: 'kungal',
      total: 2,
      enriched: 2,
      fetchedAt: Date.now(),
      characters: [
        {
          id: 'c1',
          n: '本多 世枝瑠',
          o: 'Honda Cécile',
          role: '主角',
          cv: '榊木春乃',
          img: '',
          meta: '女 · 143cm',
          intro: '零没有血缘关系的妹妹。',
          about: '零没有血缘关系的妹妹。其实是一直喜欢哥哥的那个人。',
          traits: [
            { g: '角色身份', n: '妹妹' },
            { g: '角色身份', n: '实妹', sp: 'major' },
            { g: '关系', n: '青梅竹马', sp: 'minor' }
          ],
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

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>probe-spoiler</title>
<style>
  body{margin:0;background:#15161a;color:#e7e9f0;font-family:"Microsoft YaHei",system-ui,sans-serif}
  .tabs{display:flex;gap:8px;padding:12px}
  .head{padding:8px 16px;font-size:20px}
  .info{padding:0 16px 8px;font-size:13px;color:#9aa}
  [role="tab"]{padding:6px 14px;background:transparent;color:#bbb;border:1px solid transparent;border-radius:8px;cursor:pointer}
</style></head><body>
<div class="head">剧透测试作品</div>
<div class="info" role="tabpanel" id="pane-info">
  <div><b>原名</b><span>スポイルテスト</span></div>
  <div><b>译名</b><span>剧透测试作品</span></div>
</div>
<div class="tabs" role="tablist">
  <button role="tab" data-state="active" aria-selected="true">概览</button>
  <button role="tab" data-state="inactive" aria-selected="false">记录</button>
  <button role="tab" data-state="inactive" aria-selected="false">存档</button>
  <button role="tab" data-state="inactive" aria-selected="false">回忆</button>
</div>
<div role="tabpanel" id="pane-overview">剧透测试作品</div>
<div role="tabpanel" id="pane-record" style="display:none">记录</div>
<div role="tabpanel" id="pane-save" style="display:none">存档</div>
<div role="tabpanel" id="pane-memory" style="display:none">回忆</div>
<pre id="probe-out">PENDING</pre>
<script>try{location.hash = '#/library/games/g-spoil/group-1'}catch(e){}; window.__VNCP_DATA__ = ${JSON.stringify(DATA)}; window.__VNCP_QUEUE__ = [];</script>
<script>${BOOTSTRAP_SOURCE}</script>
<script>
(async function () {
  const out = []
  try {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    await wait(900)
    const tab = document.getElementById('vncp-tab')
    out.push('标签注入=' + !!tab)
    if (tab) { tab.click(); await wait(200) }

    const cardTags = Array.from(document.querySelectorAll('#vncp-panel .vncp-card:first-child .vncp-chip')).map((n) => n.textContent)
    out.push('卡片小标签=' + cardTags.join(','))

    const card = document.querySelector('#vncp-panel .vncp-card')
    card.click()
    await wait(250)

    const modal = document.getElementById('vncp-modal')
    out.push('详情弹窗=' + !!modal)
    const plainHits = Array.from(document.querySelectorAll('.vncp-modal .vncp-trait-hit:not(.vncp-trait-spoil)')).map((n) => n.textContent)
    out.push('无剧透标签=' + plainHits.join(','))
    const box = document.querySelector('.vncp-spoiler-box')
    const spoils = box ? Array.from(box.querySelectorAll('.vncp-trait-hit')).map((n) => n.textContent) : []
    out.push('折叠区标签=' + spoils.join(','))
    out.push('折叠区可见=' + (box ? box.style.display !== 'none' : 'n/a'))
    const toggle = document.querySelector('.vncp-trait-toggle')
    out.push('剧透按钮=' + (toggle ? toggle.textContent : '无') + ' data-open=' + (toggle ? toggle.getAttribute('data-open') : 'n/a'))

    if (toggle) {
      toggle.click()
      await wait(120)
      const opened = document.querySelector('.vncp-spoiler-box')
      out.push('点击后折叠区可见=' + (opened ? opened.style.display !== 'none' : 'n/a'))
      out.push('点击后按钮=' + toggle.textContent + ' data-open=' + toggle.getAttribute('data-open'))
      toggle.click()
      await wait(120)
      const closed = document.querySelector('.vncp-spoiler-box')
      out.push('再点后折叠区可见=' + (closed ? closed.style.display !== 'none' : 'n/a'))
      out.push('再点后按钮=' + toggle.textContent + ' data-open=' + toggle.getAttribute('data-open'))
    }
    // ?open=1 时把剧透展开，方便截图（不影响上面的断言）
    if (location.search.indexOf('open') >= 0) {
      const again = document.querySelector('.vncp-trait-toggle')
      if (again && again.getAttribute('data-open') === '0') again.click()
      await wait(150)
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

const dom = chrome(['--headless=new', '--disable-gpu', '--window-size=1400,900', '--virtual-time-budget=9000', '--dump-dom', url])
const png = path.join(OUT, 'spoiler.png')
chrome(['--headless=new', '--disable-gpu', '--window-size=1400,900', '--virtual-time-budget=9000', '--screenshot=' + png, url])
const pngOpen = path.join(OUT, 'spoiler-open.png')
chrome(['--headless=new', '--disable-gpu', '--window-size=1400,900', '--virtual-time-budget=9000', '--screenshot=' + pngOpen, url + '?open=1'])

const text = dom
  .split('\n')
  .filter((line) => line.includes('RESULT '))
  .join('\n')
  .replace(/<[^>]+>/g, '')
  .trim()
console.log(text || '没有拿到结果')

const checks = [
  ['标签注入', /标签注入=true/],
  ['卡片只显示无剧透标签', /卡片小标签=妹妹/],
  ['卡片不含剧透标签', /卡片小标签=(?!.*实妹)(?!.*青梅竹马)/],
  ['详情弹窗打开', /详情弹窗=true/],
  ['默认展开的标签只有无剧透', /无剧透标签=妹妹/],
  ['折叠区里有两条剧透标签', /折叠区标签=实妹,青梅竹马/],
  ['折叠区默认不可见', /折叠区可见=false/],
  ['默认按钮文案', /剧透按钮=显示剧透（2） data-open=0/],
  ['点击后可见', /点击后折叠区可见=true/],
  ['点击后按钮变收起', /点击后按钮=收起剧透（2） data-open=1/],
  ['再点后收起', /再点后折叠区可见=false/],
  ['再点后按钮复原', /再点后按钮=显示剧透（2） data-open=0/]
]

let bad = 0
for (const [name, re] of checks) {
  if (re.test(text)) console.log('✅ ' + name)
  else {
    bad++
    console.log('❌ ' + name)
  }
}
console.log(bad === 0 ? '\n✅ 剧透开关全部通过' : `\n❌ ${bad} 项未通过`)
console.log('截图:', png, '|', pngOpen)
process.exit(bad === 0 ? 0 : 1)
