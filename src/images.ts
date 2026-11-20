import { createHash } from 'crypto'
import { existsSync, promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * 人物头像的本地缓存。
 *
 * 需求是「图片下载到本地，而不是在线加载」：Vnite 的渲染进程在详情页里
 * 直接用 <img src> 拉远程地址会受网络与防盗链影响，而且断网就白板。
 * 这里在主进程把图片抓下来、用 electron 的 nativeImage 缩到卡片尺寸并存盘，
 * 推给渲染进程的是 `data:image/jpeg;base64,...`，渲染端完全不联网。
 *
 * 目录：`<Vnite 数据目录>/app/database/character-atlas/images/<角色名>__<sha1>.jpg`
 *   - 便携版：`<Vnite 根目录>/app/database/character-atlas/images`
 *   - 安装版：`%APPDATA%/vnite/app/database/character-atlas/images`
 *   （在数据库目录**里面**，所以官方「备份数据库」把它一起打走；
 *     拿不到 electron 时退回 os.tmpdir()，仅供 Node 探针使用）
 */

/** 缓存目录名：和插件 id 保持一致，卸载插件时用户一眼认得出该删哪个 */
export const CACHE_DIR_NAME = 'character-atlas'

interface ElectronLike {
  app?: { getPath?: (name: string) => string }
  nativeImage?: {
    createFromBuffer: (buffer: Buffer) => {
      isEmpty: () => boolean
      resize: (options: { width?: number; height?: number; quality?: string }) => {
        toJPEG: (quality: number) => Buffer
      }
      toJPEG: (quality: number) => Buffer
    }
  }
}

/** 卡片里头像显示 76×100 左右，给 2x 冗余 */
const TARGET_WIDTH = 168
const JPEG_QUALITY = 82
const TIMEOUT_MS = 20000

function loadElectron(): ElectronLike | null {
  if (!process.versions || !process.versions.electron) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('electron') as ElectronLike
  } catch {
    return null
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

/** 按魔数识别图片类型；拿不到就用响应头，最后兜底 jpeg */
function detectMime(buffer: Buffer, contentType: string | null): string {
  if (buffer.length > 12) {
    if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
      return 'image/webp'
    }
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif'
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg'
  }
  const header = (contentType ?? '').split(';')[0].trim().toLowerCase()
  if (header.indexOf('image/') === 0) return header
  return 'image/jpeg'
}

function extensionOf(mime: string): string {
  if (mime === 'image/png') return '.png'
  if (mime === 'image/webp') return '.webp'
  if (mime === 'image/gif') return '.gif'
  return '.jpg'
}

export class ImageCache {
  private readonly electron = loadElectron()
  /** url → data URI（进程内一级缓存，避免反复读盘） */
  private readonly memory = new Map<string, string>()
  private dirPromise: Promise<string> | null = null

  constructor(private readonly log: (message: string) => void = () => undefined) {}

  /**
   * 缓存根目录：**直接放进 Vnite 的数据库目录**。
   *
   * 为什么这么做：Vnite 的「备份数据库」是把整个 `<数据目录>/app/database`
   * 打成 zip（`backupDatabase` → `zipFolder(getDataPath())`），图片只要在这个
   * 目录下面，就会被官方备份一起带走，恢复备份后头像不用重新下载。
   *
   * 便携模式沿用 Vnite 自己的判定：`dirname(app.getPath('exe'))` 下存在 `app/database`。
   * 非便携：`<userData>/app/database`。拿不到 electron 时退回系统临时目录（Node 探针）。
   */
  private baseDir(): string {
    const { dir } = this.resolveBase()
    return dir
  }

  /**
   * 选数据目录，并给出判定理由（启动时写一行日志，出问题一眼能看出走的是哪条）。
   *
   * 判定顺序（对齐 Vnite 自己的 `getDataPath()`：便携 = `<exe 同目录>/app/database`，
   * 否则 = `<userData>/app/database`）：
   * 1. `<exe 同目录>/app/database/plugin` 存在 → 便携版（Vnite 每次启动都会建 plugin 库，最可靠）
   * 2. `<exe 同目录>/app/database` 存在 → 便携版
   * 3. `<exe 同目录>/app` 存在 → 便携版（数据库还没建出来，但目录结构已经说明是便携版）
   * 4. 以上都不成立 → 安装版，用 `%APPDATA%\vnite\app\database`
   * 5. 拿不到 electron（Node 探针）→ 系统临时目录
   */
  private resolveBase(): { dir: string; reason: string } {
    try {
      const exe = this.electron?.app?.getPath?.('exe') ?? ''
      if (exe) {
        const root = path.join(path.dirname(exe), 'app')
        const portable = path.join(root, 'database')
        if (existsSync(path.join(portable, 'plugin'))) {
          return { dir: portable, reason: '便携版（exe 同目录有 app/database/plugin）' }
        }
        if (existsSync(portable)) {
          return { dir: portable, reason: '便携版（exe 同目录有 app/database）' }
        }
        if (existsSync(root)) {
          return { dir: portable, reason: '便携版（exe 同目录有 app，数据库尚未创建）' }
        }
      }
    } catch (error) {
      void error
    }
    try {
      const userData = this.electron?.app?.getPath?.('userData') ?? ''
      if (userData) {
        return { dir: path.join(userData, 'app', 'database'), reason: '安装版（userData）' }
      }
    } catch (error) {
      void error
    }
    // Node 探针下没有 electron，退回系统临时目录（目录名相同，便于排查）
    return { dir: path.join(os.tmpdir(), 'vnite-database'), reason: '无 electron（探针）' }
  }

  /** 供启动日志使用：`<目录>（<判定理由>）` */
  describeDir(): string {
    const { dir, reason } = this.resolveBase()
    return `${path.join(dir, CACHE_DIR_NAME, 'images')}（${reason}）`
  }

  /** 同步版目录（给「打开缓存目录」用） */
  dirSync(): string {
    return path.join(this.baseDir(), CACHE_DIR_NAME, 'images')
  }

  private dir(): Promise<string> {
    if (!this.dirPromise) {
      this.dirPromise = (async () => {
        const target = path.join(this.baseDir(), CACHE_DIR_NAME, 'images')
        await fs.mkdir(target, { recursive: true })
        await this.migrateLegacy(target)
        return target
      })()
    }
    return this.dirPromise
  }

  /**
   * 老版本的图片放在**数据库目录之外**：
   *   便携版  `<Vnite 根>/app/character-atlas/images`
   *   安装版  `<userData>/character-atlas/images`
   * 现在搬到数据库目录里了，把旧文件复制过来，用户不用重新下载一遍。
   */
  private async migrateLegacy(target: string): Promise<void> {
    try {
      const bases = [path.dirname(this.baseDir()), path.dirname(path.dirname(this.baseDir()))]
      for (const base of bases) {
        const legacy = path.join(base, CACHE_DIR_NAME, 'images')
        if (path.resolve(legacy) === path.resolve(target)) continue
        if (!(await exists(legacy))) continue
        const names = await fs.readdir(legacy)
        for (const name of names) {
          const from = path.join(legacy, name)
          const to = path.join(target, name)
          if (await exists(to)) continue
          try {
            await fs.copyFile(from, to)
          } catch {
            /* 单个文件失败不影响整体 */
          }
        }
      }
    } catch {
      /* 迁移失败就用新目录，不影响使用 */
    }
  }

  private sha1Of(url: string, width: number): string {
    return createHash('sha1').update(width + '|' + url).digest('hex')
  }

  /**
   * 文件名主干：`角色名(作品名)__<sha1前8位>`。
   * 带 hash 是为了同名角色不互相覆盖；没有 label 时退回纯 hash（老行为）。
   */
  private fileBase(url: string, width: number, label?: string): string {
    const pretty = this.prettyName(label)
    const hash = this.sha1Of(url, width).slice(0, 8)
    return pretty ? pretty + '__' + hash : hash
  }

  /** 旧版本的文件名（纯 sha1），用来兼容旧缓存并顺手改名 */
  private legacyBase(url: string, width: number): string {
    return this.sha1Of(url, width)
  }

  /**
   * 把「角色名(作品名)」变成安全的文件名：去掉 Windows 不允许的字符并压掉空白。
   * 例：`坂上 智代(CLANNAD | 克兰纳德)` → `坂上智代(CLANNAD克兰纳德)`
   */
  private prettyName(label?: string): string {
    const raw = String(label || '')
      .replace(/[\\/:*?"<>|\r\n\t]/g, '')
      .replace(/\s+/g, '')
    return raw.length > 60 ? raw.slice(0, 60) : raw
  }

  /** 把远程图片变成本地 data URI；失败返回 undefined（渲染端显示首字占位） */
  async resolve(
    url: string | null | undefined,
    width = TARGET_WIDTH,
    label?: string
  ): Promise<string | undefined> {
    const source = (url ?? '').trim()
    if (!source) return undefined
    if (source.startsWith('data:')) return source
    const targetWidth = width > 0 ? Math.round(width) : TARGET_WIDTH

    const memoKey = targetWidth + '|' + source
    const memo = this.memory.get(memoKey)
    if (memo) return memo

    // 用户换过的本地图：`local:<绝对路径>` —— 直接读盘缩图，不联网
    if (source.indexOf('local:') === 0) {
      try {
        const raw = await fs.readFile(source.slice(6))
        let bytes: Buffer = raw
        let mime = detectMime(raw, null)
        const nativeImage = this.electron?.nativeImage
        if (nativeImage) {
          const image = nativeImage.createFromBuffer(raw)
          if (!image.isEmpty()) {
            bytes = Buffer.from(
              image.resize({ width: targetWidth, quality: 'good' }).toJPEG(JPEG_QUALITY)
            )
            mime = 'image/jpeg'
          }
        }
        const uri = 'data:' + mime + ';base64,' + bytes.toString('base64')
        this.memory.set(memoKey, uri)
        return uri
      } catch (error) {
        this.log(`本地图片读取失败 ${source}: ${String(error)}`)
        return undefined
      }
    }

    try {
      const dir = await this.dir()
      const base = path.join(dir, this.fileBase(source, targetWidth, label))

      const extensions = ['.jpg', '.webp', '.png', '.gif']
      let hit: string | null = null
      for (const ext of extensions) {
        if (await exists(base + ext)) {
          hit = base + ext
          break
        }
      }
      if (!hit) {
        // 旧版本存的是纯 sha1 文件名：读到就顺手改成新名字，避免目录里一堆哈希名
        const legacy = path.join(dir, this.legacyBase(source, targetWidth))
        for (const ext of extensions) {
          if (!(await exists(legacy + ext))) continue
          const renamed = base + ext
          try {
            await fs.rename(legacy + ext, renamed)
            hit = renamed
          } catch {
            hit = legacy + ext
          }
          break
        }
      }

      if (hit) {
        const cached = await fs.readFile(hit)
        const mime = detectMime(cached, null)
        const uri = 'data:' + mime + ';base64,' + cached.toString('base64')
        this.memory.set(memoKey, uri)
        return uri
      }

      const response = await fetch(source, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Accept: 'image/*' }
      })
      if (!response.ok) {
        this.log(`头像下载失败 ${response.status}: ${source}`)
        return undefined
      }
      const raw = Buffer.from(await response.arrayBuffer())
      // 上游给的是 WebP（RIFF....WEBP），别硬当成 jpeg 存
      let mime = detectMime(raw, response.headers.get('content-type'))

      // 缩到卡片尺寸再存盘：51 张原图直接内联会有几 MB，缩完 ~8KB/张
      let bytes: Buffer = raw
      const nativeImage = this.electron?.nativeImage
      if (nativeImage) {
        try {
          const image = nativeImage.createFromBuffer(raw)
          if (!image.isEmpty()) {
            bytes = Buffer.from(
              image.resize({ width: targetWidth, quality: 'good' }).toJPEG(JPEG_QUALITY)
            )
            mime = 'image/jpeg'
          }
        } catch (error) {
          this.log(`头像缩放失败，退回原图: ${String(error)}`)
        }
      }

      const target = path.join(dir, this.fileBase(source, targetWidth, label) + extensionOf(mime))
      await fs.writeFile(target, bytes)
      const uri = 'data:' + mime + ';base64,' + bytes.toString('base64')
      this.memory.set(memoKey, uri)
      return uri
    } catch (error) {
      this.log(`头像缓存失败 ${source}: ${String(error)}`)
      return undefined
    }
  }

  /**
   * 把用户选的本地图片复制进缓存目录（跟着 Vnite 的「备份数据库」一起走），
   * 返回落盘后的绝对路径；换图只记这个路径，不动原文件。
   */
  async storeLocal(file: string): Promise<string | null> {
    try {
      const raw = await fs.readFile(file)
      const hash = createHash('sha1').update(raw).digest('hex').slice(0, 16)
      const dir = await this.dir()
      const ext = (path.extname(file) || '.jpg').toLowerCase()
      const target = path.join(dir, 'custom__' + hash + ext)
      await fs.writeFile(target, raw)
      this.memory.delete(Math.round(TARGET_WIDTH) + '|local:' + target)
      return target
    } catch (error) {
      this.log(`本地图片复制失败 ${file}: ${String(error)}`)
      return null
    }
  }

  /** 批量：限制并发，避免一次打满 51 个连接 */
  async resolveMany(
    urls: Array<string | null | undefined>,
    concurrency = 4,
    labels?: Map<string, string>
  ): Promise<Map<string, string>> {
    const unique: string[] = []
    for (const url of urls) {
      const text = (url ?? '').trim()
      if (text && unique.indexOf(text) < 0) unique.push(text)
    }
    const output = new Map<string, string>()
    let cursor = 0
    const workers = new Array(Math.min(concurrency, unique.length || 1)).fill(0).map(async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= unique.length) return
        const url = unique[index]
        const uri = await this.resolve(url, TARGET_WIDTH, labels ? labels.get(url) : undefined)
        if (uri) output.set(unique[index], uri)
      }
    })
    await Promise.all(workers)
    return output
  }

  /**
   * 导出用：只读**已经缓存过**的图片，绝不联网。
   * 返回 `{ 文件名: { mime, data(base64) } }`，文件名与缓存目录里的真实文件名一致，
   * 导入时原样写回即可命中缓存。
   */
  async collect(
    entries: Array<{ url: string | null; width: number; label?: string }>
  ): Promise<Record<string, { mime: string; data: string }>> {
    const output: Record<string, { mime: string; data: string }> = {}
    let dir = ''
    try {
      dir = await this.dir()
    } catch {
      return output
    }
    for (const entry of entries) {
      const source = (entry.url ?? '').trim()
      if (!source || source.indexOf('data:') === 0) continue
      const width = entry.width > 0 ? Math.round(entry.width) : TARGET_WIDTH
      const base = this.fileBase(source, width, entry.label)
      const extensions = ['.jpg', '.webp', '.png', '.gif']
      for (const ext of extensions) {
        const file = path.join(dir, base + ext)
        if (!(await exists(file))) continue
        try {
          const bytes = await fs.readFile(file)
          output[path.basename(file)] = {
            mime: detectMime(bytes, null),
            data: bytes.toString('base64')
          }
        } catch {
          /* 单个文件读失败就跳过 */
        }
        break
      }
    }
    return output
  }

  /** 导入用：把导出包里的图片写回缓存目录，返回写入数量 */
  async restore(
    bundle: Record<string, { mime?: string; data?: string }> | undefined | null
  ): Promise<number> {
    if (!bundle) return 0
    let dir = ''
    try {
      dir = await this.dir()
    } catch {
      return 0
    }
    let count = 0
    for (const key of Object.keys(bundle)) {
      const name = path.basename(String(key))
      if (!name || name.indexOf('.') === 0) continue
      const item = bundle[key]
      if (!item || typeof item.data !== 'string' || !item.data) continue
      try {
        const bytes = Buffer.from(item.data, 'base64')
        if (!bytes.length) continue
        await fs.writeFile(path.join(dir, name), bytes)
        this.memory.clear()
        count += 1
      } catch {
        /* 单个文件写失败就跳过 */
      }
    }
    return count
  }

  /** 缓存体积与条目数（面板/日志用） */
  async stats(): Promise<{ files: number; bytes: number }> {
    try {
      const dir = await this.dir()
      const names = await fs.readdir(dir)
      let bytes = 0
      for (const name of names) {
        try {
          const info = await fs.stat(path.join(dir, name))
          bytes += info.size
        } catch {
          /* 忽略单文件错误 */
        }
      }
      return { files: names.length, bytes }
    } catch {
      return { files: 0, bytes: 0 }
    }
  }
}
