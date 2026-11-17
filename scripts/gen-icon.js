/**
 * 生成插件图标 icon.png（256x256，RGBA）。
 * 纯 Node 实现（zlib 编码 PNG），不依赖任何图像库，方便在 CI 里重建。
 * 用法：node scripts/gen-icon.js
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const SIZE = 256
const SS = 3 // 超采样倍数（抗锯齿）

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ]
}

const BG_TOP = [26, 32, 48]
const BG_BOTTOM = [10, 12, 18]
const ACCENT = [124, 156, 255]
const PINK = [255, 143, 177]

function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false
  const cx = Math.min(Math.max(x, left + radius), right - radius)
  const cy = Math.min(Math.max(y, top + radius), bottom - radius)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= radius * radius
}

/** 返回某点的 rgba（0..255），坐标 0..SIZE */
function sample(x, y) {
  const nx = x / SIZE
  const ny = y / SIZE

  // 渐变底
  let color = mix(BG_TOP, BG_BOTTOM, Math.min(1, ny * 1.1))

  // 左上角蓝色柔光
  const glow = Math.hypot(nx - 0.18, ny - 0.1)
  const glowAlpha = Math.max(0, 1 - glow / 0.85) ** 2 * 0.55
  color = mix(color, ACCENT, glowAlpha)

  // 右上角粉色柔光
  const glow2 = Math.hypot(nx - 0.88, ny - 0.06)
  const glowAlpha2 = Math.max(0, 1 - glow2 / 0.7) ** 2 * 0.32
  color = mix(color, PINK, glowAlpha2)

  // 圆角卡片底
  if (!insideRoundedRect(x, y, 8, 8, SIZE - 8, SIZE - 8, 56)) {
    return [0, 0, 0, 0]
  }

  let alpha = 255

  // 人物剪影：头
  const headR = 34
  const headD = Math.hypot(x - 128, y - 98)
  if (headD <= headR) {
    color = mix(color, ACCENT, 0.92)
  } else if (headD <= headR + 2) {
    color = mix(color, ACCENT, 0.45)
  }

  // 人物剪影：肩膀（胶囊）
  if (insideRoundedRect(x, y, 58, 142, 198, 214, 34)) {
    color = mix(color, mix(ACCENT, PINK, 0.35), 0.86)
  }

  // 底部两条「人物栏」装饰条
  if (insideRoundedRect(x, y, 46, 224, 148, 232, 4)) color = mix(color, [220, 228, 255], 0.8)
  if (insideRoundedRect(x, y, 156, 224, 210, 232, 4)) color = mix(color, [150, 168, 220], 0.6)

  return [color[0], color[1], color[2], alpha]
}

function buildPixels() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS
          const py = y + (sy + 0.5) / SS
          const [cr, cg, cb, ca] = sample(px, py)
          const w = ca / 255
          r += cr * w
          g += cg * w
          b += cb * w
          a += ca
        }
      }
      const total = SS * SS
      const alpha = a / total
      const norm = alpha > 0 ? a / 255 : 1
      const offset = (y * SIZE + x) * 4
      pixels[offset] = Math.round(r / norm)
      pixels[offset + 1] = Math.round(g / norm)
      pixels[offset + 2] = Math.round(b / norm)
      pixels[offset + 3] = Math.round(alpha)
    }
  }
  return pixels
}

function encodePng(pixels) {
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0
    pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(SIZE, 0)
  ihdr.writeUInt32BE(SIZE, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const out = path.resolve(__dirname, '..', 'icon.png')
fs.writeFileSync(out, encodePng(buildPixels()))
console.log(`icon.png 已生成: ${out} (${SIZE}x${SIZE})`)
