const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, '.tmp', 'native')
const pkgVersion = require('../package.json').version
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

const dist = require(path.join(ROOT, 'dist', 'index.js'))
const BOOTSTRAP = dist.BOOTSTRAP_SOURCE
const snapshot = JSON.parse(fs.readFileSync(path.join(OUT, 'snapshot.json'), 'utf8'))

const TABLIST = `<div class="tablist" role="tablist">
<button role="tab" data-state="active" aria-selected="true" class="tab">概览</button>
<button role="tab" data-state="inactive" aria-selected="false" class="tab">记录</button>
<button role="tab" data-state="inactive" aria-selected="false" class="tab">存档</button>
<button role="tab" data-state="inactive" aria-selected="false" class="tab">回忆</button>
</div>
<div role="tabpanel"><div class="side"><h3>基本信息</h3><div>原名</div><div>クラナド</div><div>译名</div><div>CLANNAD | 克兰纳德</div></div></div>`

const BASE_CSS = `body{margin:0;background:#1b1c21;color:#eee;font-family:"Microsoft YaHei",sans-serif}
 .tablist{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;padding:10px}
 .tab{background:none;border:0;color:inherit;padding:8px;font:inherit}
 .side{width:250px;padding:1rem}`

function writePage(id, hash, body, script, data) {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${id}</title>
<style>${BASE_CSS}</style></head><body>${body}
<script>window.__VNCP_DATA__=${JSON.stringify(data || snapshot)};location.hash='${hash}';${BOOTSTRAP}</script>
<script>${script}</script></body></html>`
  const file = path.join(OUT, id + '.html')
  fs.writeFileSync(file, html, 'utf8')
  return file
}

function dump(file) {
  const dom = execFileSync(
    CHROME,
    ['--headless=new', '--disable-gpu', '--virtual-time-budget=9000', '--dump-dom', 'file:///' + file.replace(/\\/g, '/')],
    { maxBuffer: 1e8 }
  ).toString()
  return dom.replace(/<script[\s\S]*?<\/script>/g, '')
}

const count = (html, re) => (html.match(re) || []).length
const results = []
const check = (name, ok, extra) => {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' | ' + extra : ''}`)
}

// ── 1：弹窗里点标签 → 变成「跨所有作品搜索」 ──
const twoWorks = {
  v: 777,
  label: '',
  games: [].concat(
    (snapshot.games || []).map((g) => ({ ...g, id: g.id || 'clannad' })),
    [
      {
        id: 'other-work',
        workName: '别的作品',
        total: 1,
        enriched: 0,
        source: 'kungal',
        names: ['别的作品'],
        characters: [
          {
            n: '别家 角色',
            o: '',
            alt: '',
            role: '主角',
            cv: '别人的声优',
            meta: '女 · 1-1',
            intro: '别的作品里的角色',
            img: '',
            traits: [{ g: '毛发', n: '银色' }],
            aliases: []
          }
        ]
      }
    ]
  )
}
const traitPage = writePage(
  'mock-trait-search',
  '#/library/games/clannad/all',
  TABLIST,
  `setTimeout(()=>{document.getElementById('vncp-tab')?.click()},400);
setTimeout(()=>{document.querySelector('#vncp-panel .vncp-card')?.click()},1300);
setTimeout(()=>{document.querySelector('#vncp-modal .vncp-trait-hit')?.click()},2200);`,
  twoWorks
)
const traitDom = dump(traitPage)
const searchValue = (traitDom.match(/class="vncp-search"[^>]*value="([^"]*)"/) || [])[1] || ''
const searchTitle = /class="vncp-title"[^>]*>搜索：/.test(traitDom)
const workBadge = /class="vncp-cardwork"/.test(traitDom)
check(
  '弹窗点标签 → 全局搜索（跨作品）',
  searchTitle && workBadge && searchValue.length > 0,
  `输入框=${searchValue || '(空)'} 结果标题=${searchTitle} 作品徽章=${workBadge}`
)

// ── 2：卡片上的 chip 仍然不可点 ──
const cardChipHit = /#vncp-panel[\s\S]{0,20000}?class="vncp-chip vncp-chip-hit"/.test(traitDom)
check('卡片上 chip 不可点', !cardChipHit)

// ── 3：面板头部只剩「重新刮削 / 清空本作」 ──
const ghosts = ['>导出<', '>导入<', '>清空<', '>目录<'].filter((t) => traitDom.indexOf(t) >= 0)
check('面板头部不再有导出/导入/清空/目录', ghosts.length === 0, `残留=${ghosts.join(',') || '无'}`)

// ── 4：工具条=对话框里的普通设置项（排在最后、不浮动、不遮底部按钮） ──
const settingsBody = `<style>
.dialog{width:620px;margin:60px auto;padding:18px;border:1px solid #444;border-radius:12px}
.rows{display:block}
.row{display:flex;justify-content:space-between;padding:12px 0;border-top:1px solid #333}
.footer{display:flex;justify-content:flex-end;gap:10px;padding-top:14px}
</style>
<div class="page"><h1>插件</h1>
<div class="card"><div class="card-head"><b>character-atlas</b><span>${pkgVersion}</span></div></div>
<div role="dialog" class="dialog"><div class="dialog-head" style="font-weight:600;margin-bottom:8px">⚙ 配置 character-atlas</div>
<div class="rows">
  <div class="row"><div><b>缓存有效期（小时）</b><div>过了这个时间才会在后台静默刷新一次</div></div><input type="range"></div>
  <div class="row"><div><b>本地限流（次/分）</b><div>服务端匿名档 50 次/分</div></div><input type="range"></div>
  <div class="row"><div><b>人物头像下载到本地</b><div>以 data URI 交给界面</div></div><input type="checkbox"></div>
  <div class="row"><div><b>VNDB 兜底</b><div>KunGalgame 未收录该作品时</div></div><input type="checkbox"></div>
</div>
<div class="footer"><button>取消</button><button>保存</button></div>
</div></div>`

const settingsPage = writePage('mock-settings2', '#/plugin', settingsBody, '')
const settings = dump(settingsPage)
const tools = ['导出人物数据', '导入人物数据', '清空全部人物', '打开缓存目录'].map((name) => ({
  name,
  ok: settings.indexOf('>' + name + '<') >= 0
}))
const barAttrs = (settings.match(/id="vncp-settings-tools"[^>]*/) || [''])[0]
check(
  '设置页四个按钮都在',
  tools.every((item) => item.ok),
  tools.map((item) => (item.ok ? '✓' : '✗') + item.name).join(' ')
)
check('按钮上没有多余的悬停说明', !/id="vncp-settings-tools"[\s\S]{0,900}?title=/.test(settings))
const inRows = /class="rows"[\s\S]*?id="vncp-settings-tools"[\s\S]*?class="footer"/.test(settings)
const afterLastRow = /VNDB 兜底[\s\S]*?id="vncp-settings-tools"/.test(settings)
check(
  '工具条作为普通设置项排在配置列表末尾',
  inRows && afterLastRow,
  `在配置列表内=${inRows} 排在最后=${afterLastRow}`
)
check('不再是浮动层（不吃掉底部按钮）', !/id="vncp-settings-tools"[^>]*style="[^"]*position:\s*fixed/.test(settings))
check('工具条只注入一份', count(settings, /id="vncp-settings-tools"/g) === 1, `份数=${count(settings, /id="vncp-settings-tools"/g)}`)

// ── 5：切到记录后不会两个下划线同时亮 ──
const switchPage = writePage(
  'mock-underline',
  '#/library/games/clannad/all',
  TABLIST,
  `setTimeout(()=>{document.getElementById('vncp-tab')?.click()},400);
setTimeout(()=>{Array.from(document.querySelectorAll('[role="tab"]')).filter(t=>t.id!=='vncp-tab')[1]?.click()},1500);`
)
const switched = dump(switchPage)
const tabStates = [...switched.matchAll(/<button[^>]*role="tab"[^>]*data-state="(active|inactive)"[^>]*>([\s\S]*?)<\/button>/g)].map(
  (m) => ({ state: m[1], text: m[2].replace(/<[^>]+>/g, '').trim() })
)
const activeTexts = tabStates.filter((item) => item.state === 'active').map((item) => item.text)
check('同时只有一个标签高亮', activeTexts.length === 1, `active=${JSON.stringify(activeTexts)}`)

// ── 6：残留面板被清理 ──
const stalePage = writePage(
  'mock-stale',
  '#/library/games/clannad/all',
  TABLIST,
  `setTimeout(()=>{document.getElementById('vncp-tab')?.click()},400);
setTimeout(()=>{
  const live=document.getElementById('vncp-panel');
  if(live){const dup=live.cloneNode(true);dup.querySelectorAll('.vncp-card').forEach(n=>n.remove());
  dup.appendChild(Object.assign(document.createElement('div'),{className:'vncp-note',textContent:'残留卡片_不该出现'}));
  live.parentElement.appendChild(dup);}
},1600);`
)
const staleDom = dump(stalePage)
check(
  '残留面板被清理',
  count(staleDom, /id="vncp-panel"/g) === 1 && staleDom.indexOf('残留卡片_不该出现') < 0,
  `panel=${count(staleDom, /id="vncp-panel"/g)}`
)

// ── 7：特征分组排版 + 可点反馈 ──
const groupFlex = /\.vncp-trait-group\{[^}]*display:flex/.test(traitDom) && /\.vncp-trait-group\{[^}]*gap:6px/.test(traitDom)
const hitHover = /\.vncp-trait-hit:hover\{[^}]*border-color:var\(--vncp-accent\)/.test(traitDom)
check('特征分组横向排列 + 可点标签有反馈', groupFlex && hitHover, `flex=${groupFlex} hover=${hitHover}`)

// ── 8：搜索框直接输入也跨作品 ──
const searchPage = writePage(
  'mock-search',
  '#/library/games/clannad/all',
  TABLIST,
  `setTimeout(()=>{document.getElementById('vncp-tab')?.click()},400);
setTimeout(()=>{const box=document.querySelector('#vncp-panel .vncp-search');
if(box){box.value='银色';box.dispatchEvent(new Event('input',{bubbles:true}));}},1400);`,
  twoWorks
)
const searchDom = dump(searchPage)
check(
  '搜索框输入命中别的作品',
  searchDom.indexOf('别家 角色') >= 0 && /class="vncp-cardwork"/.test(searchDom),
  `命中=${searchDom.indexOf('别家 角色') >= 0}`
)

// ── 9：切到别的作品时清空搜索状态 ──
const switchSearchPage = writePage(
  'mock-switch-search',
  '#/library/games/clannad/all',
  TABLIST,
  `setTimeout(()=>{document.getElementById('vncp-tab')?.click()},400);
setTimeout(()=>{const box=document.querySelector('#vncp-panel .vncp-search');
  if(box){box.value='银色';box.dispatchEvent(new Event('input',{bubbles:true}));}},1400);
setTimeout(()=>{location.hash='#/library/games/other-work/all'},2400);`,
  twoWorks
)
const switchedSearch = dump(switchSearchPage)
const inputAfter = (switchedSearch.match(/class="vncp-search"[^>]*value="([^"]*)"/) || [])[1] || ''
const stillSearch = /class="vncp-title"[^>]*>搜索：/.test(switchedSearch)
const showsOther = switchedSearch.indexOf('别家 角色') >= 0
check(
  '切作品后搜索状态自动清空',
  inputAfter === '' && !stillSearch && showsOther,
  `输入框=${inputAfter === '' ? '(空)' : inputAfter} 仍在搜索=${stillSearch} 显示新作品人物=${showsOther}`
)

const ok = results.every((item) => item.ok)
console.log('\n结论:', ok ? `✅ UI 行为全部通过（${pkgVersion}）` : '❌ 有断言失败')
process.exit(ok ? 0 : 1)
