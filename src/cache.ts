import type { IPluginAPI } from 'vnite-plugin-sdk'
import type { CharacterPanelData } from './kungal/characters'
import { kvGet, kvSet } from './pluginKv'

/**
 * 本地缓存层。
 *
 * SDK 没有「磁盘文件」类 API，插件可用的唯一持久化能力是 PluginDB 的 KV
 * （IPluginDB.getValue / setValue，落到 Vnite 的插件数据里）。因此这里按
 * `charpanel:v1:<gameId>` 分键存放整份人物面板数据：
 *   - 命中且未过期 → 直接返回，零网络请求；
 *   - 过期 → 返回 stale 数据（stale-while-revalidate），后台再刷新；
 *   - 过期太久（> hardTtl，默认 TTL 的 4 倍）→ 视为未命中。
 * 另外缓存「gameId → kungal workId」的解析结果，省掉重复的名称搜索。
 *
 * 所有读写都走 `kvGet`/`kvSet`：它们对 PouchDB 的 409 conflict 做退避重试，
 * 否则首次激活时并发创建文档会直接炸掉。
 */

const PREFIX = 'charpanel:v1'
const HARD_TTL_FACTOR = 4

export interface CacheEntry<T> {
  schemaVersion: 1
  cachedAt: number
  data: T
}

export interface CacheLookup<T> {
  data: T
  cachedAt: number
  ageMs: number
  fresh: boolean
}

function entryKey(gameId: string): string {
  return `${PREFIX}:${gameId}`
}

function workKey(gameId: string): string {
  return `${PREFIX}:work:${gameId}`
}

export interface WorkResolution {
  workId: string
  matchedBy: string
  query: string | null
  resolvedAt: number
}

export class CharacterCache {
  private readonly api: IPluginAPI

  constructor(api: IPluginAPI) {
    this.api = api
  }

  /** 读缓存；ttlHours 内为 fresh，hard TTL 内为 stale，超过则 null */
  async getPanel(gameId: string, ttlHours: number): Promise<CacheLookup<CharacterPanelData> | null> {
    const entry = await kvGet<CacheEntry<CharacterPanelData> | null>(this.api, entryKey(gameId), null)
    if (!entry || !entry.data || typeof entry.cachedAt !== 'number') return null

    const ageMs = Date.now() - entry.cachedAt
    const ttlMs = Math.max(1, ttlHours) * 3600_000
    if (ageMs > ttlMs * HARD_TTL_FACTOR) return null

    return { data: entry.data, cachedAt: entry.cachedAt, ageMs, fresh: ageMs <= ttlMs }
  }

  async setPanel(gameId: string, data: CharacterPanelData): Promise<void> {
    const entry: CacheEntry<CharacterPanelData> = { schemaVersion: 1, cachedAt: Date.now(), data }
    await kvSet(this.api, entryKey(gameId), entry)
  }

  async invalidate(gameId: string): Promise<void> {
    // 写入空哨兵而不是 null：部分 KV 实现不接受 null，空 data 在读取侧同样判定为未命中
    const tombstone: CacheEntry<null> = { schemaVersion: 1, cachedAt: 0, data: null }
    await kvSet(this.api, entryKey(gameId), tombstone)
    await kvSet(this.api, workKey(gameId), { workId: '', matchedBy: '', query: null, resolvedAt: 0 })
  }

  async getWorkResolution(gameId: string): Promise<WorkResolution | null> {
    const entry = await kvGet<WorkResolution | null>(this.api, workKey(gameId), null)
    if (!entry || typeof entry.workId !== 'string') return null
    return entry
  }

  async setWorkResolution(gameId: string, resolution: Omit<WorkResolution, 'resolvedAt'>): Promise<void> {
    await kvSet(this.api, workKey(gameId), { ...resolution, resolvedAt: Date.now() })
  }
}
