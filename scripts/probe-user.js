/**
 * 用户实机对齐探针：拿 Kungal 上「高坂ものの」的真实数据（figure + image + 性特质 + 机翻简介），
 * 生成一张仿 Vnite 详情页 + 我们弹窗的截图，确认「两张图 / 原生名 + 罗马字 / 来源标注」都对。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const pluginModule = require('../dist/index.js')
const { BOOTSTRAP_SOURCE, ImageCache } = pluginModule

const OUT = path.resolve(__dirname, '..', '.tmp', 'native')
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
fs.mkdirSync(OUT, { recursive: true })

const API = 'https://api.nextmoe.dev/v2'
const CHAR_ID = process.argv[2] || '9451'

async function getJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(url + ' → ' + res.status + ' ' + (await res.text()).slice(0, 160))
  return res.json()
}

function facts(character) {
  const out = []
  if (character.gender) out.push({ k: '性别', v: character.gender === 'female' ? '女' : '男' })
  if (character.birthday) out.push({ k: '生日', v: character.birthday })
  if (character.height_cm) out.push({ k: '身高', v: character.height_cm + 'cm' })
  if (character.weight_kg) out.push({ k: '体重', v: character.weight_kg + 'kg' })
  const m = character.measurements
  if (m) {
    const parts = []
    if (m.bust_cm) parts.push('B' + m.bust_cm)
    if (m.waist_cm) parts.push('W' + m.waist_cm)
    if (m.hip_cm) parts.push('H' + m.hip_cm)
    if (m.cup) parts.push(m.cup + ' cup')
    if (parts.length) out.push({ k: '三围', v: parts.join(' / ') })
  }
  if (character.blood_type) out.push({ k: '血型', v: String(character.blood_type).toUpperCase() })
  if (character.work_count) out.push({ k: '登场作品', v: character.work_count + ' 部' })
  return out
}

async function main() {
  const detail = await getJson(
    API +
      '/catalog/characters/' +
      CHAR_ID +
      '?include=intros,traits,gender,birthday,height_cm,weight_kg,measurements,blood_type,aliases,image,figure,work_count&nsfw=true'
  )

  const cache = new ImageCache(() => {})
  const figUri = detail.figure && detail.figure.url ? await cache.resolve(detail.figure.url) : undefined
  const imgUri = detail.image && detail.image.url ? await cache.resolve(detail.image.url) : undefined

  const localized = detail.localized || {}
  const alt = localized.ja && localized.ja.value ? localized.ja.value : ''
  const intro = (detail.intros || []).find((item) => item.lang === 'zh-Hans') || (detail.intros || [])[0]

  const character = {
    n: detail.display_name,
    alt,
    role: '主角',
    img: imgUri,
    src: detail.image && detail.image.url,
    fig: figUri,
    figSrc: detail.figure && detail.figure.url,
    cv: '',
    meta: [detail.gender === 'female' ? '女' : '男', detail.height_cm ? detail.height_cm + 'cm' : '']
      .filter(Boolean)
      .join(' · '),
    intro: intro ? String(intro.value).slice(0, 320) : '',
    about: intro ? String(intro.value) : '',
    introSource: intro ? intro.source : '',
    introMachine: intro ? intro.is_machine : false,
    facts: facts(detail),
    aliases: (detail.aliases || []).map((item) => item.value).filter(Boolean).slice(0, 8),
    traits: (detail.traits || [])
      .filter((item) => item.is_lie !== true)
      .map((item) => ({
        g: (item.group_localized && item.group_localized['zh-Hans'] && item.group_localized['zh-Hans'].value) || item.group,
        n: (item.localized && item.localized['zh-Hans'] && item.localized['zh-Hans'].value) || item.display_name,
        s: item.is_sexual || undefined
      }))
  }

  const data = {
    v: 1,
    label: '',
    games: [
      {
        id: 'noble',
        names: ['のーぶる☆わーくす', 'NOBLE☆WORKS'],
        source: 'kungal',
        workName: 'NOBLE☆WORKS',
        total: 1,
        enriched: 1,
        characters: [character]
      }
    ]
  }

  const html = buildHtml(BOOTSTRAP_SOURCE, JSON.stringify(data))
  const file = path.join(OUT, 'mock-user.html')
  fs.writeFileSync(file, html, 'utf8')
  const png = path.join(OUT, 'mock-user.png')
  execFileSync(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--virtual-time-budget=6000',
      '--window-size=1400,900',
      '--screenshot=' + png,
      'file:///' + file.replace(/\\/g, '/')
    ],
    { stdio: 'pipe' }
  )
  console.log('弹窗截图:', png)
  console.log('角色:', character.n, '| 译名:', character.alt, '| 立绘:', !!figUri, '| 头像:', !!imgUri)
  console.log('特质:', character.traits.length, '| 含性特质:', character.traits.some((t) => t.s))
}

function buildHtml(bootstrap, dataJson) {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8" /><title>Vnite mock（用户实机对齐）</title>
<style>
  body{margin:0;background:#1b1d22;color:#e8e8ea;font-family:"Microsoft YaHei",sans-serif;font-size:14px}
  .shell{display:flex;min-height:100vh}
  .sidebar{width:270px;background:#20232a;padding:14px}
  .sidebar h2{font-size:13px;margin:12px 0 8px;color:#9aa0aa;font-weight:600}
  .sidebar div.item{padding:6px 8px;border-radius:8px;margin-bottom:4px;background:#262a33;font-size:13px}
  .main{flex:1;min-width:0;display:flex;gap:26px;padding:18px 22px}
  .content{flex:1 1 auto;min-width:0}
  .tabs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;border-bottom:1px solid #333a45}
  .tab{background:none;border:0;color:#c9ccd3;padding:10px 1px;font:inherit;cursor:pointer;border-bottom:2px solid transparent}
  .tab[data-state=active]{color:#fff;border-bottom-color:#8ab4ff}
  .panel{padding:16px 2px;color:#c9ccd3;line-height:1.9}
  .side{width:250px;flex:0 0 auto}
  .side h3{margin:0 0 10px;font-size:14px}
  .info{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:13px}
  .info b{color:#8f96a3;font-weight:400}
</style></head><body>
<div class="shell">
  <aside class="sidebar">
    <h2>最近游戏</h2>
    <div class="item">思影</div>
    <div class="item">Custom cute</div>
    <h2>所有游戏</h2>
    <div class="item">NOBLE☆WORKS</div>
  </aside>
  <main class="main">
    <div class="content">
      <div class="tabs" role="tablist">
        <button class="tab" role="tab" type="button" aria-selected="true" data-state="active">概览</button>
        <button class="tab" role="tab" type="button" aria-selected="false" data-state="inactive">记录</button>
        <button class="tab" role="tab" type="button" aria-selected="false" data-state="inactive">存档</button>
        <button class="tab" role="tab" type="button" aria-selected="false" data-state="inactive">回忆</button>
      </div>
      <div role="tabpanel" class="panel">
        <div class="game-title">NOBLE☆WORKS</div>
        <p>简介：主人公就读学园……</p>
      </div>
    </div>
    <aside class="side">
      <h3>基本信息</h3>
      <div class="info">
        <b>原名</b><span>のーぶる☆わーくす</span>
        <b>译名</b><span>NOBLE☆WORKS</span>
        <b>排序名称</b><span>暂无</span>
      </div>
    </aside>
  </main>
</div>
<script>
  window.__VNCP_DATA__ = ${dataJson};
  ${bootstrap}
  // 先点亮我们注入的标签（面板只有激活时才渲染），再点第一张卡打开详情弹窗
  setTimeout(function () {
    var tab = document.getElementById('vncp-tab');
    if (tab) tab.click();
  }, 700);
  (function clickCard(attempt) {
    var card = document.querySelector('#vncp-panel .vncp-card');
    if (card) {
      card.click();
      return;
    }
    if (attempt < 25) setTimeout(function () { clickCard(attempt + 1); }, 200);
  })(0);
</script>
</body></html>`
}

main().catch((error) => {
  console.error('失败:', error)
  process.exitCode = 1
})
