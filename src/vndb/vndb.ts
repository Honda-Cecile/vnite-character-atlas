import type { CharacterPanelData, PanelCharacter } from '../kungal/characters'

/**
 * VNDB Kana API 兜底数据源。
 *
 * 动机：KunGalgame（NextMoe）目录收录并不完整——例如 Yuzusoft 的「のーぶる☆わーくす」
 * 在 /catalog/search 里 0 条结果，而 VNDB 有完整人物表。当游戏带 vndbId 且 KunGalgame
 * 未收录时，用 VNDB 补上，界面才有东西可看。
 *
 * 关键约束（来自 https://api.vndb.org/kana 文档）：
 * - POST /kana/character，筛选「出现在某 VN 的角色」必须用嵌套 vn 过滤：
 *   filters = ["vn", "=", ["id", "=", "v1519"]]（写成 ["vn","=","v1519"] 会 400 Invalid query）
 * - /kana/vn 没有 characters 字段，只能反向从 character 侧查
 * - 免鉴权，限速 200 次 / 5 分钟，一次请求最多 100 条
 */

const VNDB_ENDPOINT = 'https://api.vndb.org/kana'

const CHARACTER_FIELDS = [
  'name',
  'original',
  'aliases',
  'description',
  'image.url',
  'image.sexual',
  'sex',
  'blood_type',
  'birthday',
  'height',
  'weight',
  'bust',
  'waist',
  'hips',
  'cup',
  'age',
  'vns.role',
  'vns.spoiler',
  'traits.name',
  'traits.group_name',
  'traits.spoiler',
  'traits.sexual'
].join(',')

const VN_FIELDS = 'title,alttitle,titles.title,titles.latin,titles.lang,image.url,aliases,released'

export class VndbError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'VndbError'
  }
}

interface VndbImage {
  url?: string | null
  sexual?: number | null
}

interface VndbVnRef {
  id?: string
  role?: string | null
  spoiler?: number | null
}

interface VndbTrait {
  name?: string | null
  group_name?: string | null
  spoiler?: number | null
  sexual?: boolean | null
}

interface VndbCharacter {
  id: string
  name?: string | null
  original?: string | null
  aliases?: string[] | null
  description?: string | null
  image?: VndbImage | null
  sex?: string[] | null
  blood_type?: string | null
  birthday?: number[] | null
  height?: number | null
  weight?: number | null
  bust?: number | null
  waist?: number | null
  hips?: number | null
  cup?: string | null
  age?: number | null
  vns?: VndbVnRef[] | null
  traits?: VndbTrait[] | null
}

interface VndbVn {
  id: string
  title?: string | null
  alttitle?: string | null
  aliases?: string[] | null
  released?: string | null
  image?: VndbImage | null
  titles?: Array<{ title?: string | null; latin?: string | null; lang?: string | null }> | null
}

interface VndbListResponse<T> {
  results?: T[]
  more?: boolean
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${VNDB_ENDPOINT}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  })
  const text = await response.text()
  if (!response.ok) {
    // VNDB 的错误响应是纯文本（不是 JSON），直接透出前 200 字
    throw new VndbError(`VNDB 请求失败 (${response.status}): ${text.slice(0, 200)}`, response.status)
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new VndbError('VNDB 返回了非 JSON 内容', response.status)
  }
}

/** 把 vndbId（v86 / 86 / V86）统一成 vNNN */
export function normalizeVnId(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim()
  if (!raw) return null
  const match = /^[vV]?(\d+)$/.exec(raw)
  if (!match) return null
  return `v${match[1]}`
}

const SEX_LABEL: Record<string, string> = {
  m: 'male',
  f: 'female',
  b: 'both',
  n: 'sexless'
}

const ROLE_ORDER: Record<string, number> = { main: 0, primary: 1, side: 2, appears: 3 }
const ROLE_LABEL: Record<string, string> = { main: '主角', primary: '主要人物', side: '配角', appears: '登场' }

function bestRole(character: VndbCharacter): { role: string; spoiler: string } {
  const refs = (character.vns ?? []).filter(Boolean)
  if (refs.length === 0) return { role: 'appears', spoiler: 'none' }
  const sorted = [...refs].sort((a, b) => {
    const roleDiff = (ROLE_ORDER[a.role ?? 'appears'] ?? 9) - (ROLE_ORDER[b.role ?? 'appears'] ?? 9)
    if (roleDiff !== 0) return roleDiff
    return (a.spoiler ?? 0) - (b.spoiler ?? 0)
  })
  const top = sorted[0]
  return { role: top.role ?? 'appears', spoiler: (top.spoiler ?? 0) > 0 ? 'minor' : 'none' }
}

/** VNDB 简介里带 [url=…]、[spoiler]…[/spoiler] 之类的标记，面板里直接剥掉 */
function cleanDescription(value: string | null | undefined): string {
  if (!value) return ''
  return value
    .replace(/\[url=[^\]]*\]/gi, '')
    .replace(/\[\/url\]/gi, '')
    .replace(/\[spoiler\][\s\S]*?\[\/spoiler\]/gi, '')
    .replace(/\[[a-z]+(=[^\]]*)?\]/gi, '')
    .replace(/\[\/[a-z]+\]/gi, '')
    .replace(/\r/g, '')
    .trim()
}

function formatBirthday(value: number[] | null | undefined): string | null {
  if (!Array.isArray(value) || value.length < 2) return null
  const month = Number(value[0])
  const day = Number(value[1])
  if (!Number.isFinite(month) || month < 1 || month > 12) return null
  const mm = String(month).padStart(2, '0')
  if (!Number.isFinite(day) || day < 1) return mm
  return `${mm}-${String(day).padStart(2, '0')}`
}

function mapTraits(traits: VndbTrait[] | null | undefined): Array<{ group: string; name: string; sexual: boolean }> {
  if (!traits || traits.length === 0) return []
  const seen = new Set<string>()
  const out: Array<{ group: string; name: string; sexual: boolean }> = []
  for (const trait of traits) {
    const name = (trait.name ?? '').trim()
    if (!name) continue
    if ((trait.spoiler ?? 0) >= 1) continue
    const group = (trait.group_name ?? 'Other').trim()
    const key = `${group}::${name}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ group, name, sexual: trait.sexual === true })
  }
  return out
}

function toPositive(value: number | null | undefined): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function toPanelCharacter(character: VndbCharacter, lang: string): PanelCharacter {
  const original = (character.original ?? '').trim()
  const latin = (character.name ?? '').trim()
  // VNDB 没有中文名；中文界面下用原名（日文）当主名，罗马字进别名，避免显示一堆拼音
  const useOriginal = lang !== 'en' && original.length > 0
  const name = useOriginal ? original : latin || original
  const { role, spoiler } = bestRole(character)
  const measurements =
    character.bust || character.waist || character.hips || character.cup
      ? {
          bust_cm: toPositive(character.bust),
          waist_cm: toPositive(character.waist),
          hip_cm: toPositive(character.hips),
          cup: character.cup ?? null
        }
      : null

  const aliases = (character.aliases ?? [])
    .map((alias) => (alias ?? '').trim())
    .filter((alias) => alias.length > 0 && alias !== name && alias !== latin && alias !== original)

  return {
    id: `vndb:${character.id}`,
    name,
    nameMachine: false,
    nameAlt: '',
    nameAltMachine: false,
    originalName: original || latin,
    latin: latin || null,
    role,
    roleLabel: ROLE_LABEL[role] ?? '其他',
    spoiler,
    imageUrl: character.image?.url ?? null,
    figureUrl: null,
    thumbhash: null,
    voices: [],
    intro: cleanDescription(character.description),
    introSource: 'vndb',
    introMachine: false,
    gender: character.sex?.[0] ? SEX_LABEL[character.sex[0]] ?? character.sex[0] : null,
    birthday: formatBirthday(character.birthday),
    heightCm: toPositive(character.height),
    weightKg: toPositive(character.weight),
    measurements,
    bloodType: character.blood_type ?? null,
    traits: mapTraits(character.traits),
    aliases,
    workCount: null,
    links: [{ source: 'vndb', url: `https://vndb.org/${character.id}`, is_identity: false, page_id: null }],
    enriched: true,
    enrichError: null
  }
}

export interface VndbScrapeOptions {
  lang: string
  maxCharacters: number
  log?: (message: string, detail?: unknown) => void
}

/** 用 VNDB 抓一部作品的人物表（2 次请求：作品信息 + 角色列表） */
export async function scrapeVndbCharacters(
  vnId: string,
  options: VndbScrapeOptions
): Promise<CharacterPanelData> {
  const vn = normalizeVnId(vnId)
  if (!vn) throw new VndbError(`无效的 VNDB 作品号：${vnId ?? '(空)'}`)

  const vnResponse = await post<VndbListResponse<VndbVn>>('/vn', {
    filters: ['id', '=', vn],
    fields: VN_FIELDS,
    results: 1
  })
  const work = vnResponse.results?.[0]
  if (!work) throw new VndbError(`VNDB 上找不到作品 ${vn}`, 404)

  const characterResponse = await post<VndbListResponse<VndbCharacter>>('/character', {
    filters: ['vn', '=', ['id', '=', vn]],
    fields: CHARACTER_FIELDS,
    results: 100,
    sort: 'id'
  })

  const warnings: string[] = []
  const characters = (characterResponse.results ?? [])
    .map((character) => toPanelCharacter(character, options.lang))
    .sort((a, b) => {
      const roleDiff = (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9)
      if (roleDiff !== 0) return roleDiff
      return a.name.localeCompare(b.name)
    })

  const limit = Math.max(0, Math.min(options.maxCharacters, characters.length))
  if (limit > 0 && limit < characters.length) {
    warnings.push(`按设置只展示前 ${limit} 位人物（VNDB 共 ${characters.length} 位）`)
  }
  if (characterResponse.more) {
    warnings.push('VNDB 返回结果超过 100 条，已截断')
  }

  const shown = limit > 0 ? characters.slice(0, limit) : characters
  const originalTitle = (work.titles ?? []).find((item) => item && item.lang === 'ja')?.title ?? work.alttitle ?? null

  options.log?.(`VNDB 刮削完成: ${work.title} (${vn}) → ${shown.length} 人`)

  return {
    schemaVersion: 2,
    source: 'vndb',
    workId: work.id,
    workName: work.title ?? vn,
    workOriginalName: originalTitle ?? work.alttitle ?? work.title ?? vn,
    workLatin: work.title ?? null,
    coverUrl: work.image?.url ?? null,
    bannerUrl: null,
    lang: options.lang,
    fetchedAt: Date.now(),
    total: characters.length,
    enrichedCount: shown.filter((character) => character.enriched).length,
    truncated: shown.length < characters.length,
    duplicates: 0,
    characters: shown,
    warnings
  }
}
