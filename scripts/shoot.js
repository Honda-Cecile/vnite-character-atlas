const { execFileSync } = require('child_process')
const path = require('path')

const src = process.argv[2] || 'mock-user.html'
const out = process.argv[3] || 'user-shot.png'
const file = path.resolve(__dirname, '..', '.tmp', 'native', src)
const png = path.resolve(__dirname, '..', '.tmp', 'native', out)

execFileSync(
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--virtual-time-budget=8000',
    '--window-size=1400,900',
    '--screenshot=' + png,
    'file:///' + file.replace(/\\/g, '/')
  ],
  { stdio: 'pipe' }
)
console.log('shot:', png)
