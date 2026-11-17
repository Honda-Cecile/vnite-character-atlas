import type { IPluginAPI } from 'vnite-plugin-sdk'
import { kvGetMany } from './pluginKv'

export interface PanelConfig {
  apiKey: string
  baseUrl: string
  lang: string
  nsfw: boolean
  maxCharacters: number
  autoOnLaunch: boolean
  syncToMetadata: boolean
  cacheTtlHours: number
  localRateLimit: number
  /** 在游戏详情页标签栏注入原生「人物」标签页 */
  nativeTab: boolean
  /** 标签页文字（留空则随界面语言：人物 / Characters） */
  nativeTabLabel: string
  /** 头像下载到本地并以 data URI 注入（关掉则直接用远程 URL） */
  localImages: boolean
  /** KunGalgame 未收录时用 VNDB 兜底（需要游戏带 vndbId） */
  vndbFallback: boolean
  /** 导出人物数据时把已缓存的图片（头像 / 立绘）一起打进 JSON */
  exportImages: boolean
}

export const DEFAULT_BASE_URL = 'https://api.nextmoe.dev/v2'

const DEFAULT_CONFIG: PanelConfig = {
  apiKey: '',
  baseUrl: DEFAULT_BASE_URL,
  lang: 'zh-Hans',
  nsfw: true,
  maxCharacters: 12,
  // 默认开着：新增游戏 / 启动游戏时自动把人物补上（用户明确要求「新增游戏时也要自动刮」）
  autoOnLaunch: true,
  syncToMetadata: false,
  cacheTtlHours: 720,
  localRateLimit: 45,
  nativeTab: true,
  nativeTabLabel: '',
  localImages: true,
  vndbFallback: true,
  // 默认开着：导出的 JSON 自带图片，换机器/重装后不用重新下载
  exportImages: true
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * 读取插件设置。
 * 设置项由 manifest 的 configuration 声明，Vnite 写入 PluginDB（与 kungal-catalog 约定一致）。
 * 任一项缺失/类型异常都回落到默认值，避免激活阶段抛错。
 *
 * 注意：这里**串行**读 key。Vnite 的 getValue 在文档不存在时会 db.put 建文档，
 * 并发读会撞 409 Document update conflict，把 activate 整个打挂。
 */
export async function readConfig(api: IPluginAPI): Promise<PanelConfig> {
  const loaded = await kvGetMany(api, {
    apiKey: DEFAULT_CONFIG.apiKey,
    baseUrl: DEFAULT_CONFIG.baseUrl,
    lang: DEFAULT_CONFIG.lang,
    nsfw: DEFAULT_CONFIG.nsfw,
    maxCharacters: DEFAULT_CONFIG.maxCharacters,
    autoOnLaunch: DEFAULT_CONFIG.autoOnLaunch,
    syncToMetadata: DEFAULT_CONFIG.syncToMetadata,
    cacheTtlHours: DEFAULT_CONFIG.cacheTtlHours,
    localRateLimit: DEFAULT_CONFIG.localRateLimit,
    nativeTab: DEFAULT_CONFIG.nativeTab,
    nativeTabLabel: DEFAULT_CONFIG.nativeTabLabel,
    localImages: DEFAULT_CONFIG.localImages,
    vndbFallback: DEFAULT_CONFIG.vndbFallback,
    exportImages: DEFAULT_CONFIG.exportImages
  })

  const apiKey = loaded.apiKey
  const baseUrl = loaded.baseUrl
  const lang = loaded.lang
  const nsfw = loaded.nsfw
  const maxCharacters = loaded.maxCharacters
  const autoOnLaunch = loaded.autoOnLaunch
  const syncToMetadata = loaded.syncToMetadata
  const cacheTtlHours = loaded.cacheTtlHours
  const localRateLimit = loaded.localRateLimit
  const nativeTab = loaded.nativeTab
  const nativeTabLabel = loaded.nativeTabLabel
  const localImages = loaded.localImages
  const vndbFallback = loaded.vndbFallback
  const exportImages = loaded.exportImages

  return {
    apiKey: String(apiKey ?? '').trim(),
    baseUrl: String(baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '') || DEFAULT_BASE_URL,
    lang: String(lang ?? 'zh-Hans'),
    nsfw: nsfw !== false,
    maxCharacters: clampNumber(maxCharacters, DEFAULT_CONFIG.maxCharacters, 0, 60),
    autoOnLaunch: autoOnLaunch === true,
    syncToMetadata: syncToMetadata === true,
    cacheTtlHours: clampNumber(cacheTtlHours, DEFAULT_CONFIG.cacheTtlHours, 1, 720),
    localRateLimit: clampNumber(localRateLimit, DEFAULT_CONFIG.localRateLimit, 5, 60),
    nativeTab: nativeTab !== false,
    nativeTabLabel: String(nativeTabLabel ?? '').trim(),
    localImages: localImages === true,
    vndbFallback: vndbFallback !== false,
    exportImages: exportImages !== false
  }
}
