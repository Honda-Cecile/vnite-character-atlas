/**
 * 给右键菜单 / 编辑弹窗出图（本地验证用，不进包）。
 * 复用 probe-edit.js 里的页面模板，插入 __VNCP_SHOT__ 开关让页内脚本停在对应状态。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const pluginModule = require('../dist/index.js')
const { BOOTSTRAP_SOURCE } = pluginModule

const OUT = path.resolve(__dirname, '..', '.tmp', 'edit')
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
fs.mkdirSync(OUT, { recursive: true })

const probeSrc = fs.readFileSync(path.join(__dirname, 'probe-edit.js'), 'utf8')
const START = 'const html = `'
const END = '</body></html>`'
const start = probeSrc.indexOf(START)
const end = probeSrc.indexOf(END)
if (start < 0 || end < 0) throw new Error('没能从 probe-edit.js 里取出 HTML 模板')
const tpl = probeSrc.slice(start + START.length, end + END.length)

const GAME = {
  id: 'g-editor',
  names: ['右键测试作品', '右クリックテスト'],
  workName: '右键测试作品',
  workId: '886',
  source: 'kungal',
  total: 3,
  enriched: 1,
  fetchedAt: Date.now(),
  truncated: false,
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
        { k: '体重', v: '47kg' },
        { k: '三围', v: 'B86/W57/H82' },
        { k: '血型', v: 'O' }
      ],
      traits: [
        { g: '发色', n: '粉色', s: false },
        { g: '性格', n: '腼腆', s: false }
      ],
      aliases: ['姫野原鈴蘭'],
      links: []
    },
    {
      id: '26440',
      n: '白檀 翠',
      role: '其他',
      cv: '吉川ナガレ',
      facts: [{ k: '性别', v: '女' }],
      traits: [],
      aliases: [],
      links: []
    },
    { id: '81083', n: '志木 春臣', role: '主角', cv: '', facts: [], traits: [], aliases: [], links: [] }
  ]
}

const DATA = { label: '', games: [GAME] }

function chrome(args) {
  return execFileSync(CHROME, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function shot(mode, name) {
  // 注意：BOOTSTRAP_SOURCE 里可能有 $& / $' 之类，只能用函数形式替换
  const html = tpl
    .replace('${JSON.stringify(DATA)}', () => JSON.stringify(DATA))
    .replace('${BOOTSTRAP_SOURCE}', () => BOOTSTRAP_SOURCE)
    .replace("window.__VNCP_QUEUE__ = [];", () => "window.__VNCP_QUEUE__ = []; window.__VNCP_SHOT__ = '" + mode + "';")
  const pagePath = path.join(OUT, 'shot-' + mode + '.html')
  fs.writeFileSync(pagePath, html, 'utf8')
  const url = 'file:///' + pagePath.replace(/\\/g, '/')
  const out = path.join(OUT, name)
  chrome([
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1400,900',
    '--virtual-time-budget=6000',
    '--screenshot=' + out,
    url
  ])
  console.log('📸 ' + out)
}

shot('menu', 'menu.png')
shot('editor', 'editor.png')
