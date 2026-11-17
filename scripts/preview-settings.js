/**
 * 生成「插件设置」页面的 mock 并截图，用来肉眼确认注入的工具条与原生设置行是否一致。
 *
 *   node scripts/preview-settings.js
 *   → .tmp/native/preview-settings.html / .png
 *
 * mock 复刻的是真实 Vnite（深色主题、玻璃拟态关闭）下 `PluginConfigDialog` 的样子：
 *   DialogContent(h-[70vh] w-[50vw]) > ScrollArea > div.space-y-4 > 每行 ConfigItem
 * ConfigItem = Card > CardContent(flex items-center justify-between) > [左:标题+说明, 右:控件]
 * 其中 Card 的背景是 `bg-card/[calc(var(--glass-opacity)/3)]`，玻璃拟态关闭时算出来是透明的，
 * 所以真实界面上这些行看上去是「没有卡片底」的纯文本块 —— 之前的 mock 画了卡片底，
 * 才会误判「已经改好了」。这里按实测外观重画。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, '.tmp', 'native')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const dist = require(path.join(ROOT, 'dist', 'index.js'))

const ROWS = [
  ['本地限流（次/分）', '服务端匿名档 50 次/分、带 key 60 次/分，本地留余量避免自己触发 429', 'slider:45'],
  ['人物头像下载到本地', '开启后插件把头像抓取到本地缓存目录（与游戏库同级 character-atlas/images），以 data URI 交给界面，断网也能显示；关闭则直接引用远程图片地址', 'switch:on'],
  ['VNDB 兜底', 'KunGalgame 未收录该作品时，用游戏自带的 VNDB 作品号去 VNDB 取人物表', 'switch:on'],
  ['导出时带上图片', '「导出人物数据」时把已下载到本地的头像 / 立绘一起打进 JSON（base64），换机器或重装后导入即可离线显示；关闭则只导出文字数据，文件小很多', 'switch:on']
]

const control = (spec) => {
  const [kind, value] = spec.split(':')
  if (kind === 'switch') {
    return `<button class="switch" role="switch" aria-checked="${value === 'on'}"><span></span></button>`
  }
  return `<div class="slider"><div class="track"><div class="fill"></div><div class="knob"></div></div><em>${value}</em></div>`
}

const row = ([name, desc, ctl]) => `<div class="card"><div class="card-content">
  <div class="label"><div class="title">${name}</div><div class="desc">${desc}</div></div>
  <div class="ctl">${control(ctl)}</div>
</div></div>`

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>preview-settings</title>
<style>
*{box-sizing:border-box}
body{margin:0;height:100vh;background:#1b1c21;color:#f2f2f4;font-family:"Microsoft YaHei",system-ui,sans-serif;
  display:flex;align-items:center;justify-content:center}
.dialog{width:50vw;height:70vh;background:#232429;border:1px solid rgba(255,255,255,.07);border-radius:12px;
  display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,.5);overflow:hidden}
.head{padding:22px 24px 6px}
.head h2{margin:0;font-size:16px;font-weight:600;letter-spacing:.2px}
.head p{margin:8px 0 0;font-size:13px;color:rgba(242,242,244,.55)}
.body{flex:1;overflow-y:auto;padding:8px 24px 0}
/* 真实 Vnite：行与行之间 space-y-4（16px），Card 自带 pb-5（20px） */
.card{width:100%;padding:0 0 20px 0}
.card+.card{margin-top:16px}
.card-content{display:flex;align-items:center;justify-content:space-between}
.label{display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:4px}
.title{font-size:15px;font-weight:600;line-height:1.2}
.desc{font-size:14px;line-height:1.5;color:rgba(242,242,244,.55)}
.ctl{flex-shrink:0;margin-left:24px}
.switch{width:44px;height:24px;border-radius:99px;background:#d8d8dc;position:relative;display:inline-block;
  border:0;cursor:pointer}
.switch span{position:absolute;top:3px;right:3px;width:18px;height:18px;border-radius:99px;background:#232429}
.switch[aria-checked="false"]{background:rgba(255,255,255,.18)}
.slider{display:flex;align-items:center;gap:12px}
.track{width:170px;height:4px;border-radius:99px;background:rgba(255,255,255,.2);position:relative}
.fill{position:absolute;left:0;top:0;height:4px;width:52%;border-radius:99px;background:#e9e9ee}
.knob{position:absolute;left:52%;top:-6px;width:16px;height:16px;border-radius:99px;background:#e9e9ee}
.slider em{font-size:13px;font-style:normal;color:rgba(242,242,244,.7);min-width:26px;text-align:right}
.foot{display:flex;justify-content:flex-end;gap:10px;padding:18px 24px}
.btn{font:inherit;font-size:13px;padding:8px 16px;border-radius:8px;border:1px solid rgba(255,255,255,.16);
  background:transparent;color:#f2f2f4;cursor:pointer}
.btn.primary{background:#f2f2f4;color:#232429;border-color:#f2f2f4}
</style></head><body>
<div class="dialog" role="dialog">
  <div class="head"><h2>配置 Character Atlas</h2><p>根据您的偏好自定义插件设置。</p></div>
  <div class="body" id="rows">${ROWS.map(row).join('')}</div>
  <div class="foot"><button class="btn">取消</button><button class="btn primary">保存</button></div>
</div>
<script>window.__VNCP_DATA__={v:777,label:'',games:[]};location.hash='#/plugin';${dist.BOOTSTRAP_SOURCE}
setTimeout(function(){var b=document.querySelector('.body');if(b)b.scrollTop=b.scrollHeight;},1200);</script>
</body></html>`

fs.mkdirSync(OUT, { recursive: true })
const file = path.join(OUT, 'preview-settings.html')
fs.writeFileSync(file, html, 'utf8')

const png = path.join(OUT, 'preview-settings.png')
execFileSync(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--virtual-time-budget=6000',
    '--window-size=1920,1080',
    '--screenshot=' + png,
    'file:///' + file.replace(/\\/g, '/')
  ],
  { stdio: 'pipe' }
)
console.log('html:', file)
console.log('shot:', png)
