const { execFileSync } = require('child_process')
const path = require('path')

const file = path.resolve(__dirname, '..', '.tmp', 'native', process.argv[2] || 'mock-user.html')
const dom = execFileSync(
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  [
    '--headless=new',
    '--disable-gpu',
    '--virtual-time-budget=6000',
    '--dump-dom',
    'file:///' + file.replace(/\\/g, '/')
  ],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
)
const clean = dom.replace(/<script[\s\S]*?<\/script>/g, '')
const panel = clean.match(/<div id="vncp-panel"[\s\S]{0,400}/)
console.log('panel:', panel ? panel[0].slice(0, 400) : 'MISSING')
console.log('modal:', /vncp-modal/.test(clean))
console.log('cards:', (clean.match(/vncp-card/g) || []).length)
console.log('figure:', /vncp-dialog-figure/.test(clean))
console.log('err:', (clean.match(/渲染异常[^<]*/) || [''])[0])
console.log('status:', (clean.match(/vncp-status[^>]*>[^<]*/) || [''])[0])
