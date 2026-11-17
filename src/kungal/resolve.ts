import { KungalError } from './client'
import type { KungalClient } from './client'
import type { ApiCharacterBrief, ApiListResponse, ApiSearchResult, ApiWork, LocalizedMap } from './types'

export interface PickedText {
  value: string
  /** 是否来自机器翻译（UI 上打「机翻」标记） */
  machine: boolean
}

function normalizeLocalized(entry: unknown): PickedText | null {
  if (typeof entry === 'string') return entry.trim() ? { value: entry.trim(), machine: false } : null
  if (entry && typeof entry === 'object') {
    const obj = entry as { value?: unknown; is_machine?: unknown }
    if (typeof obj.value === 'string' && obj.value.trim()) {
      return { value: obj.value.trim(), machine: obj.is_machine === true }
    }
  }
  return null
}

const LANG_FALLBACKS: Record<string, string[]> = {
  'zh-Hans': ['zh-Hans', 'zh-Hant', 'zh', 'ja', 'en'],
  'zh-Hant': ['zh-Hant', 'zh-Hans', 'zh', 'ja', 'en'],
  ja: ['ja', 'zh-Hans', 'zh-Hant', 'en'],
  en: ['en', 'ja', 'zh-Hans', 'zh-Hant']
}

/**
 * 从 localized 映射里按语言优先级取值。
 *
 * 注意这里的优先级是「语言优先，机翻其次」：语言链上的某一门语言只要有值就返回，
 * 即使它是机翻 —— 因为 KunGalgame 的 `ja` 字段常常存的是罗马字（如 "Ichinose Kotomi"），
 * 若让「非机翻优先」压过语言顺序，中文用户会看到一串拼音而不是中文译名。
 * 与 kungal-catalog 的 pickName 契约一致（兼容裸字符串 / {value,is_machine} 两种形态）。
 */
export function pickLocalized(map: LocalizedMap | undefined | null, lang: string): PickedText | null {
  if (!map) return null
  const chain = LANG_FALLBACKS[lang] ?? [lang, 'zh-Hans', 'zh-Hant', 'ja', 'en']

  for (const key of chain) {
    const picked = normalizeLocalized(map[key])
    if (picked) return picked
  }
  for (const [key, value] of Object.entries(map)) {
    if (key === 'ja') continue // 罗马字命名空间留作最后兜底
    const picked = normalizeLocalized(value)
    if (picked) return picked
  }
  for (const value of Object.values(map)) {
    const picked = normalizeLocalized(value)
    if (picked) return picked
  }
  return null
}

/** 名称：localized 优先，其次 display_name，最后 latin */
export function pickName(entity: { localized?: LocalizedMap; display_name?: string; latin?: string | null }, lang: string): PickedText {
  const picked = pickLocalized(entity.localized, lang)
  if (picked) return picked
  if (entity.display_name && entity.display_name.trim()) return { value: entity.display_name.trim(), machine: false }
  if (entity.latin && entity.latin.trim()) return { value: entity.latin.trim(), machine: false }
  return { value: 'Unknown', machine: false }
}

/**
 * 简介：同语言人工 > 同语言机翻 > zh-Hans > ja > en > 首条。
 * 对应 kungal-catalog 的 pickIntro 策略。
 */
export function pickIntro(
  intros: Array<{ lang?: string | null; value?: string | null; is_machine?: boolean | null; source?: string | null }> | undefined,
  lang: string
): { text: string; source: string | null; machine: boolean } | null {
  if (!intros || intros.length === 0) return null

  const usable = intros.filter((item) => typeof item.value === 'string' && item.value.trim().length > 0)
  if (usable.length === 0) return null

  const chain = [lang, 'zh-Hans', 'zh-Hant', 'ja', 'en']
  for (const key of chain) {
    const sameLang = usable.filter((item) => item.lang === key)
    if (sameLang.length === 0) continue
    const human = sameLang.find((item) => item.is_machine !== true)
    const chosen = human ?? sameLang[0]
    return {
      text: String(chosen.value).trim(),
      source: chosen.source ?? null,
      machine: chosen.is_machine === true
    }
  }

  const first = usable[0]
  return { text: String(first.value).trim(), source: first.source ?? null, machine: first.is_machine === true }
}

export interface ExternalRef {
  source: 'vndb' | 'dlsite'
  externalId: string
}

/** v86 / vndb:V86 / RJ123456 / dlsite:rj123456 一类的引用值 → 结构化 ref */
export function toRef(raw: string | null | undefined): ExternalRef | null {
  if (!raw) return null
  const text = String(raw).trim()
  if (!text) return null

  const prefixed = text.match(/^(vndb|dlsite)\s*[:/]\s*(.+)$/i)
  if (prefixed) {
    const source = prefixed[1].toLowerCase() === 'vndb' ? 'vndb' : 'dlsite'
    const id = prefixed[2].trim().toUpperCase()
    return id ? { source, externalId: id } : null
  }

  if (/^v\d+$/i.test(text)) return { source: 'vndb', externalId: text.toUpperCase() }
  if (/^(rj|re|vj)\d+$/i.test(text)) return { source: 'dlsite', externalId: text.toUpperCase() }
  if (/^\d{3,}$/.test(text)) return { source: 'vndb', externalId: `V${text}` }
  return null
}

export interface ResolveInput {
  /** gameDoc.metadata.name */
  name?: string | null
  /** gameDoc.metadata.vndbId，可能是 'v86' 或 '86' */
  vndbId?: string | null
  /** gameDoc.metadata.relatedSites */
  relatedSites?: Array<{ label?: string; url?: string }> | null
}

export interface ResolvedWork {
  workId: string
  work: ApiWork
  matchedBy: 'vndb-id' | 'related-site' | 'search'
  query: string | null
}

async function findByRef(client: KungalClient, ref: ExternalRef): Promise<ApiWork | null> {
  const list = await client.get<ApiListResponse<ApiWork>>(
    `/catalog/works?refs=${encodeURIComponent(`${ref.source}:${ref.externalId}`)}&limit=1`
  )
  const first = list.items?.[0]
  if (!first || !first.id) return null
  return client.get<ApiWork>(`/catalog/works/${encodeURIComponent(first.id)}`)
}

/** 从 relatedSites 里提取 vndb / dlsite 标识：先看 URL 里的 v/dlsite id，再看 label 后缀 */
function refFromRelatedSites(sites: Array<{ label?: string; url?: string }> | null | undefined): ExternalRef | null {
  if (!sites || sites.length === 0) return null
  for (const site of sites) {
    const url = (site.url ?? '').trim()
    if (!url) continue
    const vndb = url.match(/vndb\.org\/(?:v|vn)\/?([a-z]?\d+)/i)
    if (vndb) return { source: 'vndb', externalId: vndb[1].toUpperCase() }

    const dlsite = url.match(/dlsite\.com\/(?:[a-z]+\/)+product_id\/((?:RJ|RE|VJ)\d+)/i)
    if (dlsite) return { source: 'dlsite', externalId: dlsite[1].toUpperCase() }
  }
  // 兜底：label 里带 vndb: v1234 形式的标识
  for (const site of sites) {
    const direct = toRef(site.label)
    if (direct) return direct
  }
  return null
}

/**
 * 把 Vnite 的 gameDoc 元数据解析成 KunGalgame 的作品 id。
 * 顺序：vndbId → relatedSites(vndb/dlsite) → 名称搜索（相似度打分）。
 *
 * 关键点：外部 id 命中后还要用标题复核。实测 KunGalgame 的 refs 索引并不能稳定
 * 对应 vndb 的作品编号（例如 refs=vndb:86 回的是另一个作品 #5806），
 * 盲信外部 id 会把整份人物名单安到错误的游戏上，所以标题对不上就降级到搜索。
 */
export async function resolveWorkId(client: KungalClient, input: ResolveInput): Promise<ResolvedWork> {
  const name = (input.name ?? '').trim()
  const variants = name ? nameVariants(name) : []
  let refCandidate: { work: ApiWork; matchedBy: 'vndb-id' | 'related-site'; query: string } | null = null

  const vndbRef = toRef(input.vndbId ?? null)
  if (vndbRef) {
    const work = await findByRef(client, vndbRef)
    if (work) {
      const accepted = { workId: String(work.id), work, matchedBy: 'vndb-id' as const, query: vndbRef.externalId }
      if (!variants.length || bestTitleScore(work, variants) >= TITLE_ACCEPT) return accepted
      refCandidate = { work, matchedBy: 'vndb-id', query: vndbRef.externalId }
    }
  }

  const siteRef = refFromRelatedSites(input.relatedSites)
  const sameAsVndb =
    siteRef && vndbRef && siteRef.source === vndbRef.source && siteRef.externalId === vndbRef.externalId
  if (siteRef && !sameAsVndb) {
    const work = await findByRef(client, siteRef)
    if (work) {
      const accepted = {
        workId: String(work.id),
        work,
        matchedBy: 'related-site' as const,
        query: siteRef.externalId
      }
      if (!variants.length || bestTitleScore(work, variants) >= TITLE_ACCEPT) return accepted
      if (!refCandidate) refCandidate = { work, matchedBy: 'related-site', query: siteRef.externalId }
    }
  }

  if (!variants.length) {
    if (refCandidate) {
      return { ...refCandidate, workId: String(refCandidate.work.id) }
    }
    throw new KungalError(
      '该游戏没有可用的名字 / vndbId / 外部链接，无法在 KunGalgame 定位作品',
      undefined,
      'NO_IDENTIFIER'
    )
  }

  // Vnite 里的书名常用「原名 | 译名」拼接，整串丢进搜索会命中奇怪的东西，
  // 因此拆成独立候选逐个查，再用标题相似度打分挑最像的。
  const tried: string[] = []
  let best: { item: ApiSearchResult; score: number } | null = null

  for (const variant of variants) {
    tried.push(variant)
    const search = await client.get<ApiListResponse<ApiSearchResult>>(
      `/catalog/search?q=${encodeURIComponent(variant)}&object=work&limit=10`
    )
    const candidates = (search.items ?? []).filter((item) => (item.target_object ?? 'work') === 'work')
    for (const candidate of candidates) {
      const score = titleScore(candidate, variant)
      if (score >= 1) {
        best = { item: candidate, score: 1 }
        break
      }
      if (!best || score > best.score) best = { item: candidate, score }
    }
    if (best && best.score >= 1) break
  }

  if (!best || best.score < TITLE_ACCEPT) {
    if (refCandidate) {
      return { ...refCandidate, workId: String(refCandidate.work.id) }
    }
    throw new KungalError(
      `KunGalgame 未收录作品「${name}」（尝试过：${tried.join(' / ')}）`,
      404,
      'WORK_NOT_FOUND'
    )
  }

  const work = await client.get<ApiWork>(`/catalog/works/${encodeURIComponent(best.item.id)}?include=characters`)
  return { workId: String(work.id), work, matchedBy: 'search', query: tried[tried.length - 1] ?? name }
}

/** 「CLANNAD | 克兰纳德」→ ['CLANNAD', '克兰纳德']；无分隔符时只返回整串 */
function nameVariants(name: string): string[] {
  const parts = name
    .split(/[|｜/／]/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2)
  // 带拼接符时优先查单个名字，整串搜索命中率低
  const ordered = parts.length >= 2 ? [...parts, name.trim()] : [name.trim()]
  const unique: string[] = []
  for (const value of ordered) {
    if (value.length >= 2 && unique.indexOf(value) < 0) unique.push(value)
  }
  return unique
}

function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s\u3000・·:：\-–—_|｜/／\\.,，。!！?？'"“”‘’()（）[\]【】]/g, '')
}

function diceSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0
  const grams = (input: string): string[] => {
    const out: string[] = []
    for (let i = 0; i < input.length - 1; i++) out.push(input.slice(i, i + 2))
    return out
  }
  const left = grams(a)
  const right = grams(b)
  const counts = new Map<string, number>()
  for (const gram of left) counts.set(gram, (counts.get(gram) ?? 0) + 1)
  let hit = 0
  for (const gram of right) {
    const remaining = counts.get(gram) ?? 0
    if (remaining > 0) {
      hit++
      counts.set(gram, remaining - 1)
    }
  }
  return (2 * hit) / (left.length + right.length)
}

/** 标题相似度阈值：低于它就不认这个作品（宁可报未收录，也不把别人的人物名单塞进来） */
const TITLE_ACCEPT = 0.6

interface TitleCarrier {
  display_name?: string
  latin?: string | null
  localized?: LocalizedMap
}

/** 名字的多个候选写法里，取与作品标题相似度最高的那个 */
function bestTitleScore(work: TitleCarrier, variants: string[]): number {
  let best = 0
  for (const variant of variants) best = Math.max(best, titleScore(work, variant))
  return best
}

/** 候选作品与查询串的相似度：完全相等 1，包含 0.9，其余走 bigram Dice */
function titleScore(candidate: TitleCarrier, query: string): number {
  const target = normalizeTitle(query)
  if (!target) return 0
  const titles: string[] = []
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) titles.push(value)
  }
  push(candidate.display_name)
  push(candidate.latin)
  const localized = candidate.localized as Record<string, unknown> | undefined
  if (localized) {
    for (const value of Object.values(localized)) {
      if (typeof value === 'string') push(value)
      else if (value && typeof value === 'object') push((value as { value?: unknown }).value)
    }
  }

  let best = 0
  for (const title of titles) {
    const normalized = normalizeTitle(title)
    if (!normalized) continue
    if (normalized === target) return 1
    if (normalized.includes(target) || target.includes(normalized)) {
      best = Math.max(best, 0.9)
      continue
    }
    best = Math.max(best, diceSimilarity(normalized, target))
  }
  return best
}

/** 拉取作品详情（含角色名单），不做名字解析 */
export async function getWorkWithCharacters(client: KungalClient, workId: string): Promise<ApiWork> {
  return client.get<ApiWork>(`/catalog/works/${encodeURIComponent(workId)}?include=characters`)
}

export type { ApiCharacterBrief }
