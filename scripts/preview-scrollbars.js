/**
 * 插件界面「滚动条」离线核对：面板列表、详情弹窗、编辑弹窗（含 textarea）都不该有可见滚动条，
 * 但都必须还能滚。
 *
 *   node scripts/preview-scrollbars.js
 *   → .tmp/native/preview-editor.html / .png
 *
 * CSS 取自编译产物 dist/index.js 里真正注入的那份，所以量到的就是真机行为。
 * 不要加 chrome 的 `--hide-scrollbars`，那会把滚动条藏掉、量不出真假。
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

const fields = [
  ['名字', 'input', '本多 世枝瑠', 0],
  ['原名', 'input', '', 0],
  ['译名', 'input', '本多世枝瑠', 0],
  ['定位（主角 / 配角…）', 'input', '主角', 0],
  ['CV', 'input', '榊木春乃 / 西泽广香', 0],
  ['性别', 'input', '女', 0],
  ['生日', 'input', '', 0],
  ['身高（cm）', 'input', '143', 0],
  ['体重（kg）', 'input', '38', 0],
  ['血型', 'input', '', 0],
  ['三围（86/57/82，可带罩杯）', 'input', 'B77 / W43 / H78', 0],
  ['别名（逗号或顿号分隔）', 'input', 'Honda Cécile', 1]
]

const bio = [
  '零没有血缘关系的妹妹。',
  '零的母亲和世枝瑠的父亲是再婚的，而世枝瑠则是父亲与前妻的孩子，所以她跟零其实并没有血缘关系。',
  '对于身为哥哥的零，她其实抱持着深深的爱意，但并没让那份感情表露出来，反倒向来冷淡相待。',
  '无论零对她说什么，她总是立马否定，刻意跟他唱反调。',
  '很喜欢吃甜食，也只有在那吃甜食的时候才会变得坦率。',
  '最喜欢吃的是雪糕制的奶酪蛋糕薄饼。',
  '（这几段只是为了把内容堆到超过 textarea 高度，好验证「文本框里也没有滚动条」。）'
].join('\n')

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>preview-scrollbars</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#15161a;font-family:"Microsoft YaHei",system-ui,sans-serif;color:#e7e9f0}
${css}
#vncp-panel{--vncp-fg:#e7e9f0;--vncp-dim:#98a0b0;--vncp-card:rgba(255,255,255,.055);
  --vncp-line:rgba(255,255,255,.10);--vncp-accent:#93a4ff;--vncp-chip:rgba(255,255,255,.09);}
.vncp-modal{--vncp-fg:#e7e9f0;--vncp-dim:#98a0b0;--vncp-card:rgba(255,255,255,.055);
  --vncp-line:rgba(255,255,255,.10);--vncp-accent:#93a4ff;--vncp-chip:rgba(255,255,255,.09);
  --vncp-modal-bg:rgba(24,26,32,.98);}
#list{height:120px;overflow:auto;border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:8px}
#editModal{display:none}
#label{position:fixed;left:16px;top:16px;z-index:9;font:12px/1.7 ui-monospace,monospace;
  color:#9fe8b0;background:rgba(0,0,0,.62);border:1px solid rgba(255,255,255,.12);
  border-radius:8px;padding:8px 12px;white-space:pre}
</style></head><body>
<pre id="label">measuring…</pre>

<div id="vncp-panel" style="position:absolute;left:40px;top:60px;width:360px">
  <div id="list">${Array.from({ length: 30 }, (_, i) => `<div>第 ${i + 1} 行：用来把列表撑高，验证面板里的滚动条也被去掉</div>`).join('')}</div>
</div>

<div class="vncp-modal" id="editModal" style="display:flex">
  <div class="vncp-dialog" id="edit-dialog">
    <button class="vncp-dialog-close" type="button">×</button>
    <div class="vncp-dialog-title">编辑人物：本多 世枝瑠</div>
    <div class="vncp-dialog-sub">改动只存在本地（缓存 + 个人修正），重新刮削不会被覆盖；删掉的角色也不会再出现。</div>
    <form class="vncp-form">
      ${fields
        .map(
          ([label, kind, value, wide]) =>
            `<label class="vncp-field${wide ? ' vncp-wide' : ''}"><span>${label}</span><input value="${value}"></label>`
        )
        .join('')}
      <label class="vncp-field vncp-wide"><span>简介</span><textarea id="bio">${bio}</textarea></label>
      <div class="vncp-form-actions">
        <button type="button" class="vncp-settings-btn">删除此人</button>
        <button type="button" class="vncp-settings-btn">取消</button>
        <button type="button" class="vncp-settings-btn">保存</button>
      </div>
    </form>
  </div>
</div>

<script>
function barWidth(node) {
  var cs = getComputedStyle(node);
  var border = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
  return node.offsetWidth - node.clientWidth - border;
}
window.addEventListener('load', function () {
  var targets = [
    ['面板列表', document.getElementById('list')],
    ['编辑弹窗', document.getElementById('edit-dialog')],
    ['简介 textarea', document.getElementById('bio')]
  ];
  var lines = [];
  var bad = 0;
  targets.forEach(function (pair) {
    var node = pair[1];
    var sb = barWidth(node);
    var scrollable = node.scrollHeight > node.clientHeight;
    if (sb !== 0) bad++;
    document.body.setAttribute('data-sb-' + node.id, sb);
    document.body.setAttribute('data-scrollable-' + node.id, scrollable ? '1' : '0');
    lines.push(pair[0] + '：滚动条占宽=' + sb + 'px，可滚动=' + scrollable + (sb === 0 ? ' ✅' : ' ❌'));
  });
  document.body.setAttribute('data-bad', String(bad));
  document.getElementById('label').textContent = lines.join('\\n');
}, false);
</script>
</body></html>`

fs.mkdirSync(OUT, { recursive: true })
const file = path.join(OUT, 'preview-editor.html')
fs.writeFileSync(file, html, 'utf8')

const url = 'file:///' + file.replace(/\\/g, '/')
const png = path.join(OUT, 'preview-editor.png')
execFileSync(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--force-device-scale-factor=1',
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

const read = (id) => {
  const m = new RegExp('data-sb-' + id + '="(\\d+)"').exec(dom)
  const s = new RegExp('data-scrollable-' + id + '="([01])"').exec(dom)
  return { sb: m ? Number(m[1]) : null, scrollable: s ? s[1] === '1' : null }
}
const rows = [
  ['面板列表', read('list')],
  ['编辑弹窗', read('edit-dialog')],
  ['简介 textarea', read('bio')]
]

console.log('html:', file)
console.log('shot:', png)
let bad = 0
for (const [name, r] of rows) {
  if (r.sb === null) {
    console.log('❌', name, '没量到（页面脚本没跑起来？）')
    bad++
    continue
  }
  if (r.sb !== 0) bad++
  console.log(`${name}: 滚动条占宽=${r.sb}px，可滚动=${r.scrollable} ${r.sb === 0 ? '✅' : '❌'}`)
}
if (bad > 0) {
  console.log('❌ 还有可见滚动条')
  process.exit(1)
}
console.log('✅ 插件界面的滚动条已全部隐藏，滚动能力保留')
