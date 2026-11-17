import type { IPluginAPI } from 'vnite-plugin-sdk'

/**
 * PluginDB 的并发安全包装。
 *
 * Vnite 的 `BaseDBManager.getValue()` 在文档不存在时走的是：
 *   db.get(id) → not_found → 组一个新 doc → db.put(doc)
 * 如果多个 key 的 getValue 并发执行（比如 Promise.all 读 13 项设置），
 * 多个 put 会抢同一个 _id 且都不带 _rev，PouchDB 直接抛
 *   { status: 409, name: "conflict", message: "Document update conflict" }
 * 外层包装成 `Failed to get plugin value: ...` 并让 activate 整个失败。
 *
 * 这里做两件事：
 *   1. `ensureDoc()` 先用 upsert 建文档（upsert 自带冲突合并，安全）；
 *   2. `get`/`set` 对 conflict 做有限次退避重试，且默认串行读取。
 */

type PluginDb = IPluginAPI['PluginDB']

const KV_DOC_MARKER = '__panelDoc'
const RETRY_ATTEMPTS = 5

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return /conflict/i.test(String(error))
  const e = error as { status?: number; name?: string; message?: string; error?: unknown }
  return (
    e.status === 409 ||
    e.name === 'conflict' ||
    /document update conflict/i.test(String(e.message ?? '')) ||
    /conflict/i.test(String(e.message ?? '')) ||
    isConflict(e.error)
  )
}

/** 冲突时退避重试；其他错误原样抛出 */
export async function withConflictRetry<T>(task: () => Promise<T>, label = 'plugin-db'): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    try {
      return await task()
    } catch (error) {
      lastError = error
      if (!isConflict(error)) throw error
      await delay(30 * (attempt + 1))
    }
  }
  throw new Error(`${label} 写入/读取冲突重试 ${RETRY_ATTEMPTS} 次仍失败：${String(lastError)}`)
}

/**
 * 确保插件文档存在，返回是否成功。
 * 用 setValue 走 upsert（不存在则创建），从而把「首次创建」这一步从并发读取里摘出来。
 */
export async function ensurePluginDoc(api: IPluginAPI): Promise<boolean> {
  try {
    await withConflictRetry(
      () => api.PluginDB.setValue(KV_DOC_MARKER, { createdAt: Date.now() }),
      'ensure-plugin-doc'
    )
    return true
  } catch {
    return false
  }
}

export async function kvGet<T>(api: IPluginAPI, key: string, fallback: T): Promise<T> {
  try {
    const value = await withConflictRetry(() => api.PluginDB.getValue(key, fallback), `get:${key}`)
    return (value === undefined || value === null ? fallback : value) as T
  } catch {
    // 读失败不应该让插件起不来：设置项回落默认值
    return fallback
  }
}

export async function kvSet(api: IPluginAPI, key: string, value: unknown): Promise<boolean> {
  try {
    await withConflictRetry(() => api.PluginDB.setValue(key, value), `set:${key}`)
    return true
  } catch {
    return false
  }
}

/** 串行读取多个 key（首次激活时避免并发创建同一文档） */
export async function kvGetMany<T extends Record<string, unknown>>(
  api: IPluginAPI,
  defaults: T
): Promise<T> {
  const output = {} as Record<string, unknown>
  for (const key of Object.keys(defaults)) {
    output[key] = await kvGet(api, key, defaults[key])
  }
  return output as T
}

export { KV_DOC_MARKER, isConflict }
export type { PluginDb }
