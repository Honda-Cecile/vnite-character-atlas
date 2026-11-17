/**
 * KunGalgame / NextMoe Public API v2 请求层。
 *
 * 复用自参考插件 kungal-catalog 0.1.0 的请求逻辑（dist/kungal.js 的 fetchJson / throttleLocal /
 * handleRateLimit），并在其上做了三点扩展：
 *   1. API Key 改为可选 —— 公共读端点支持匿名访问（自带 50 次/分限流），留空即匿名模式；
 *   2. 限流窗口参数化（跟随插件设置 localRateLimit），并区分匿名/带 key 的默认额度；
 *   3. 结构化错误（KungalError 携带 status/code/detail），便于上层做「无人物数据」「作品未收录」判定。
 */

const REQUEST_TIMEOUT_MS = 15000
const RATE_LIMIT_WINDOW_MS = 60_000

export class KungalError extends Error {
  readonly status?: number
  readonly code?: string
  readonly detail?: string

  constructor(message: string, status?: number, code?: string, detail?: string) {
    super(message)
    this.name = 'KungalError'
    this.status = status
    this.code = code
    this.detail = detail
  }
}

export interface KungalClientOptions {
  apiKey: string
  baseUrl: string
  nsfw: boolean
  /** 本地滑动窗口上限（次/分） */
  rateLimit: number
  /** Key 被判无效（401/403）并自动降级匿名时回调一次，用于写日志提示用户 */
  onAuthFallback?: (status: number, detail?: string) => void
}

interface ProblemBody {
  type?: string
  title?: string
  status?: number
  detail?: string
  code?: string
  errors?: Array<{ parameter?: string; reason?: string; detail?: string; params?: unknown }>
}

/** Retry-After 头：仅支持 delta-seconds 数字格式 */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null
  const sec = Number(value)
  return Number.isFinite(sec) && sec >= 0 ? Math.ceil(sec) : null
}

export class KungalClient {
  private readonly timestamps: number[] = []
  private readonly limit: number
  /** Key 被服务端判废后置位：本次运行内不再带 Authorization，等同匿名档 */
  private dropAuth = false

  constructor(private readonly options: KungalClientOptions) {
    this.limit = Math.max(1, Math.min(60, Math.round(options.rateLimit) || 45))
  }

  get baseUrl(): string {
    return this.options.baseUrl
  }

  /** 统一拼 nsfw 查询位（kungal 的契约：不带 nsfw=true 时 R18 内容直接 404） */
  private nsfwFlag(): string {
    return this.options.nsfw ? '&nsfw=true' : ''
  }

  /**
   * 带鉴权、本地节流、限流感知的 GET。
   * path 需以 '/' 开头，且可以已经带有查询串（本方法只负责追加 nsfw）。
   */
  async get<T>(path: string, attempt = 0): Promise<T> {
    const url = `${this.options.baseUrl}${path}${path.includes('?') ? '' : '?'}${this.nsfwFlag()}`.replace(
      /\?&/,
      '?'
    )

    await this.throttle()

    const headers: Record<string, string> = { Accept: 'application/json' }
    if (this.options.apiKey && !this.dropAuth) headers.Authorization = `Bearer ${this.options.apiKey}`

    let res: Response
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch (error) {
      throw new KungalError(
        `KunGalgame 网络请求失败: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        'NETWORK_ERROR'
      )
    }

    // 失败请求同样计量（服务端也是这么算的）
    this.timestamps.push(Date.now())

    if (!res.ok) {
      const problem = await this.readProblem(res)
      if (res.status === 429) return this.handleRateLimit<T>(path, res, problem, attempt)
      if (res.status === 401 || res.status === 403) {
        // Key 失效（被撤销 / 复制错 / 根本不属于 NextMoe）时不要让整个刮削直接死掉：
        // 公共服务器的匿名档额度足够本插件使用，这里丢掉 Authorization 立刻重试一次，
        // 并在本次运行内保持匿名，避免每个请求都白撞一次 401。
        if (this.options.apiKey && !this.dropAuth) {
          this.dropAuth = true
          this.options.onAuthFallback?.(res.status, problem.detail)
          return this.get<T>(path, attempt)
        }
        throw new KungalError(
          `KunGalgame 鉴权失败 (${res.status})：请检查 API Key 与 catalog:read scope；也可清空 API Key 走匿名档`,
          res.status,
          'AUTH_FAILED',
          problem.detail
        )
      }
      if (res.status === 400 && problem.code === 'UNKNOWN_INCLUDE') {
        throw new KungalError(
          `KunGalgame 接口参数不被支持：${problem.detail ?? ''}`,
          res.status,
          problem.code,
          problem.detail
        )
      }
      throw new KungalError(
        `KunGalgame 请求失败 (${res.status})${problem.detail ? `: ${problem.detail}` : ''}`,
        res.status,
        problem.code,
        problem.detail
      )
    }

    try {
      return (await res.json()) as T
    } catch (error) {
      throw new KungalError(
        `KunGalgame 响应解析失败: ${error instanceof Error ? error.message : String(error)}`,
        res.status,
        'PARSE_ERROR'
      )
    }
  }

  private async readProblem(res: Response): Promise<ProblemBody> {
    try {
      return (await res.json()) as ProblemBody
    } catch {
      return {}
    }
  }

  /** 请求前节流：窗口满则等最早记录滑出；等待超过 5s 直接给出可读错误 */
  private async throttle(maxWaitMs = 5000): Promise<void> {
    let waited = 0
    for (;;) {
      const now = Date.now()
      while (this.timestamps.length > 0 && this.timestamps[0] <= now - RATE_LIMIT_WINDOW_MS) {
        this.timestamps.shift()
      }
      if (this.timestamps.length < this.limit) return

      const waitMs = this.timestamps[0] + RATE_LIMIT_WINDOW_MS - now
      if (waitMs <= 0) continue
      if (waited + waitMs > maxWaitMs) {
        throw new KungalError(
          `KunGalgame 本地限流已满（${this.limit} 次/分），请 ${Math.ceil(waitMs / 1000)} 秒后重试`,
          undefined,
          'LOCAL_RATE_LIMIT'
        )
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs))
      waited += waitMs
    }
  }

  /**
   * 429 处理：日配额直接提示不重试；分钟限流且 Retry-After ≤ 15s 自动等待重试一次。
   */
  private async handleRateLimit<T>(
    path: string,
    res: Response,
    problem: ProblemBody,
    attempt: number
  ): Promise<T> {
    const headerNames: string[] = []
    res.headers.forEach((_value, key) => headerNames.push(key.toLowerCase()))
    const isQuota =
      headerNames.some((k) => k.startsWith('x-quota')) || /quota|配额/i.test(problem.detail ?? '')
    if (isQuota) {
      throw new KungalError(
        'KunGalgame 今日配额已用尽，请明日再试或更换 API Key',
        res.status,
        'QUOTA_EXCEEDED'
      )
    }

    const retryAfter = parseRetryAfter(res.headers.get('retry-after'))
    const reset = parseRetryAfter(res.headers.get('x-ratelimit-reset'))
    const waitSec = retryAfter ?? reset ?? 0

    if (waitSec > 0 && waitSec <= 15 && attempt < 1) {
      await new Promise((resolve) => setTimeout(resolve, waitSec * 1000))
      return this.get<T>(path, attempt + 1)
    }

    throw new KungalError(
      `KunGalgame 请求过于频繁${waitSec > 0 ? `，请 ${waitSec} 秒后重试` : '，请稍后重试'}`,
      res.status,
      'RATE_LIMITED'
    )
  }
}
