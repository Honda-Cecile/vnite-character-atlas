/**
 * 生成「人物详情弹窗」的 mock 并截图，确认右侧那根丑滚动条真的没了。
 *
 *   node scripts/preview-dialog.js
 *   → .tmp/native/preview-dialog.html / .png
 *
 * CSS 直接取自编译产物 dist/index.js 里注入的那份（和真机完全一致），
 * 所以这里量出来的滚动条占宽就是真机上的值。
 * 注意：**不能**加 chrome 的 `--hide-scrollbars`，那会把滚动条藏起来、量不出真假。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, '.tmp', 'native')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

const bundle = fs.readFileSync(path.join(ROOT, 'dist', 'index.js'), 'utf8')
const start = bundle.indexOf('const CSS = [')
const end = bundle.indexOf("].join('')", start)
if (start < 0 || end < 0) throw new Error('没在 dist/index.js 里找到注入的 CSS 数组')
const css = new Function(bundle.slice(start, end + "].join('')".length) + '; return CSS')()

const PARAS = [
  '零没有血缘关系的妹妹。',
  '零的母亲和世枝瑠的父亲是再婚的，而世枝瑠则是父亲与前妻的孩子，所以她跟零其实并没有血缘关系。',
  '对于身为哥哥的零，她其实抱持着深深的爱意，但并没让那份感情表露出来，反倒向来冷淡相待。',
  '无论零对她说什么，她总是立马否定，刻意跟他唱反调。',
  '很喜欢吃甜食，也只有在那吃甜食的时候才会变得坦率。',
  '最喜欢吃的是雪糕制的奶酪蛋糕薄饼。',
  '（以下几段只为把内容堆到超过弹窗高度，好验证「内容溢出时也没有滚动条」，真机上不会有。）',
  '第二个冬天的早晨，她照旧把围巾往上拉一拉，只露出眼睛，然后装作没看见站在门口的那个人。',
  '零把手里的袋子递过去，里面是刚出炉的、还带着热气的点心。',
  '她沉默了三秒，接过来，转身回屋，门带得比平时轻一点。',
  '「……谢了。」声音小到几乎听不见。',
  '走廊尽头的灯忽明忽暗，像是不太确定要不要继续亮着。'
]

const FACTS = [
  ['性别', '女'],
  ['身高', '143cm'],
  ['体重', '38kg'],
  ['三围', 'B77 / W43 / H78']
]

const SVG =
  "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='168' height='224'%3E%3Crect width='168' height='224' fill='%234a4450'/%3E%3C/svg%3E"

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>preview-dialog</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#15161a;font-family:"Microsoft YaHei",system-ui,sans-serif}
${css}
.vncp-modal{--vncp-fg:#e7e9f0;--vncp-dim:#98a0b0;--vncp-card:rgba(255,255,255,.055);
  --vncp-line:rgba(255,255,255,.10);--vncp-accent:#93a4ff;--vncp-chip:rgba(255,255,255,.09);
  --vncp-modal-bg:rgba(24,26,32,.98);}
.fake{position:absolute;inset:0;background:linear-gradient(135deg,#2a2230,#1b2028 60%,#241d1d);opacity:.55}
#probe{position:fixed;right:16px;top:16px;z-index:9;font:12px/1.6 ui-monospace,monospace;
  color:#9fe8b0;background:rgba(0,0,0,.6);border:1px solid rgba(255,255,255,.12);
  border-radius:8px;padding:8px 12px;white-space:pre}
</style></head><body>
<div class="fake"></div>
<div id="probe">measuring…</div>
<div class="vncp-modal" id="vncp-modal">
  <div class="vncp-dialog" id="dialog">
    <button class="vncp-dialog-close" type="button">×</button>
    <div class="vncp-dialog-head">
      <div class="vncp-dialog-figure"><div class="vncp-dialog-ava"><img alt="" src="${SVG}"></div></div>
      <div class="vncp-dialog-info">
        <div class="vncp-dialog-title">本多 世枝瑠</div>
        <div class="vncp-dialog-sub">主角</div>
        <div class="vncp-dialog-sub">CV · 榊木春乃 / 西泽广香</div>
        <div class="vncp-dialog-sub">女 · 143cm · 38kg</div>
      </div>
    </div>
    <div class="vncp-section"><div class="vncp-section-title">资料</div>
      <div class="vncp-facts">${FACTS.map(([k, v]) => `<div class="vncp-fact"><b>${k}</b><span>${v}</span></div>`).join('')}</div>
    </div>
    <div class="vncp-section"><div class="vncp-section-title">别名</div><div class="vncp-about">Honda Cécile</div></div>
    <div class="vncp-section"><div class="vncp-section-title">简介来源</div><div class="vncp-about">Bangumi</div></div>
    <div class="vncp-section"><div class="vncp-section-title">简介</div>
      <div class="vncp-about">${PARAS.map((t) => `<p style="margin:0 0 8px">${t}</p>`).join('')}</div>
    </div>
  </div>
</div>
<script>
var dialog = document.getElementById('dialog');
window.addEventListener('load', function () {
  var cs = getComputedStyle(dialog);
  var border = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
  var sb = dialog.offsetWidth - dialog.clientWidth - border;
  var scrollable = dialog.scrollHeight > dialog.clientHeight;
  document.body.setAttribute('data-sb', sb);
  document.body.setAttribute('data-scrollable', scrollable ? '1' : '0');
  document.getElementById('probe').textContent =
    '滚动条占宽=' + sb + 'px' + (sb === 0 ? '  ✅ 没有可见滚动条' : '  ❌ 滚动条还在') +
    '\\n可滚动=' + scrollable + '\\n内容=' + dialog.scrollHeight + ' / 视口=' + dialog.clientHeight;
}, false);
</script>
</body></html>`

fs.mkdirSync(OUT, { recursive: true })
const file = path.join(OUT, 'preview-dialog.html')
fs.writeFileSync(file, html, 'utf8')

const url = 'file:///' + file.replace(/\\/g, '/')
const png = path.join(OUT, 'preview-dialog.png')
execFileSync(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--force-device-scale-factor=1',
    // 刻意不加 --hide-scrollbars：要量的是真实滚动条占宽
    '--virtual-time-budget=3000',
    '--window-size=1920,1080',
    '--screenshot=' + png,
    url
  ],
  { stdio: 'pipe' }
)

const dom = execFileSync(
  CHROME,
  ['--headless=new', '--disable-gpu', '--virtual-time-budget=3000', '--window-size=1920,1080', '--dump-dom', url],
  { stdio: 'pipe' }
).toString()

const sb = /data-sb="(\d+)"/.exec(dom)
const scrollable = /data-scrollable="([01])"/.exec(dom)

console.log('html:', file)
console.log('shot:', png)
if (!sb) {
  console.log('❌ 没量到滚动条占宽（页面脚本没跑起来？）')
  process.exit(1)
}
console.log('滚动条占宽:', sb[1] + 'px')
console.log('内容可滚动:', scrollable && scrollable[1] === '1' ? '是' : '否（内容没超过弹窗高度）')
if (Number(sb[1]) !== 0) {
  console.log('❌ 仍然存在可见滚动条')
  process.exit(1)
}
console.log('✅ 详情弹窗没有可见滚动条')
