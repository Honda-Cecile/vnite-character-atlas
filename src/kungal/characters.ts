import type { KungalClient } from './client'
import { pickIntro, pickLocalized, pickName } from './resolve'
import type {
  ApiCharacterBrief,
  ApiCharacterDetail,
  ApiCharacterLink,
  ApiCharacterTrait,
  ApiCharacterAlias,
  ApiMeasurements,
  ApiWork
} from './types'

/**
 * 角色详情所需的 include 集合。
 * 列表接口（work?include=characters）只给姓名/头像/声优，简介必须走单角色详情，
 * 因此这里是「N+1 请求」的第二跳；include 白名单来自服务端 UNKNOWN_INCLUDE 报错回显。
 */
export const CHARACTER_INCLUDE =
  'intros,traits,gender,birthday,height_cm,weight_kg,measurements,blood_type,aliases,image,figure,work_count,links'

/** 详情刮削并发上限：配合 45 次/分本地限流，3 并发不会踩服务端阈值 */
const ENRICH_CONCURRENCY = 3

export interface PanelCharacter {
  id: string
  name: string
  nameMachine: boolean
  originalName: string
  latin: string | null
  role: string
  roleLabel: string
  spoiler: string
  imageUrl: string | null
  /** 全身立绘（KunGalgame 的 figure）；Kungal 自己的角色卡就是「立绘 + 头像」两张 */
  figureUrl: string | null
  thumbhash: string | null
  /** UI 语言下的译名（与原生名不同时才填），用于「名 + 译名」两行显示 */
  nameAlt: string
  nameAltMachine: boolean
  voices: Array<{ name: string; lang: string | null }>
  intro: string
  introSource: string | null
  introMachine: boolean
  gender: string | null
  birthday: string | null
  heightCm: number | null
  weightKg: number | null
  measurements: ApiMeasurements | null
  bloodType: string | null
  traits: Array<{ group: string; name: string; sexual: boolean }>
  aliases: string[]
  workCount: number | null
  links: ApiCharacterLink[]
  /** 是否已完成详情补全（false 表示只剩列表字段，通常是超出 maxCharacters 或被限流） */
  enriched: boolean
  /** 补全失败原因，便于 UI 展示 */
  enrichError: string | null
}

export interface CharacterPanelData {
  schemaVersion: 1
  /** 数据来源：KunGalgame（NextMoe）或 VNDB 兜底 */
  source: 'kungal' | 'vndb'
  workId: string
  workName: string
  workOriginalName: string
  workLatin: string | null
  coverUrl: string | null
  bannerUrl: string | null
  lang: string
  fetchedAt: number
  total: number
  enrichedCount: number
  /** 是否因为 maxCharacters 截断 */
  truncated: boolean
  /** 被合并掉的同名重复条目数（KunGalgame 同一角色常有多条记录） */
  duplicates: number
  characters: PanelCharacter[]
  warnings: string[]
}

const ROLE_ORDER: Record<string, number> = {
  main: 0,
  primary: 1,
  side: 2,
  appears: 3,
  mentioned: 4
}

const ROLE_LABEL: Record<string, string> = {
  main: '主角',
  primary: '主要人物',
  side: '配角',
  appears: '登场',
  mentioned: '提及'
}

function roleRank(role: string): number {
  return ROLE_ORDER[role] ?? 9
}

function roleLabelOf(role: string): string {
  return ROLE_LABEL[role] ?? '其他'
}

function toNumberOrNull(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

function normalizeForCompare(value: string): string {
  return value.replace(/[\s・·.,:;'"`|/\\-]/g, '').toLowerCase()
}

function isAsciiOnly(value: string): boolean {
  return /^[\x20-\x7E]+$/.test(value)
}

/** 列表条目 → 面板人物（不含简介） */
export function fromBrief(brief: ApiCharacterBrief, lang: string): PanelCharacter {
  const picked = pickName(brief, lang)
  const role = (brief.roster_role ?? 'appears').toString()
  // display_name 是目录里的原生写法（日文/汉字），localized 里的 ja 往往是罗马字。
  // Kungal 自己的角色卡以「原生名」为主标题（高坂ものの），译名放在次要位置，
  // 所以这里也以原生名为主，localized 只作为 nameAlt。
  const original = (brief.display_name ?? '').trim()
  const name = original || picked.value
  const alt = picked.value && picked.value !== name ? picked.value : ''

  return {
    id: String(brief.id),
    name,
    nameMachine: original ? false : picked.machine,
    nameAlt: alt,
    nameAltMachine: alt ? picked.machine : false,
    originalName: original,
    latin: brief.latin ?? (original && isAsciiOnly(original) ? original : null),
    role,
    roleLabel: roleLabelOf(role),
    spoiler: (brief.spoiler ?? 'none').toString(),
    imageUrl: brief.image?.url ?? null,
    figureUrl: brief.figure?.url ?? null,
    thumbhash: brief.image?.thumbhash ?? null,
    voices: (brief.voices ?? []).map((voice) => ({
      name: pickLocalized(voice.localized, lang)?.value ?? voice.display_name ?? '',
      lang: voice.lang ?? null
    })).filter((voice) => voice.name.length > 0),
    intro: '',
    introSource: null,
    introMachine: false,
    gender: null,
    birthday: null,
    heightCm: null,
    weightKg: null,
    measurements: null,
    bloodType: null,
    traits: [],
    aliases: [],
    workCount: null,
    links: [],
    enriched: false,
    enrichError: null
  }
}

function mapTraits(traits: ApiCharacterTrait[] | undefined, lang: string): Array<{ group: string; name: string; sexual: boolean }> {
  if (!traits || traits.length === 0) return []
  const seen = new Set<string>()
  const result: Array<{ group: string; name: string; sexual: boolean }> = []
  for (const trait of traits) {
    if (trait.is_lie === true) continue
    const name = pickLocalized(trait.localized, lang)?.value ?? trait.display_name ?? ''
    if (!name.trim()) continue
    const group = pickLocalized(trait.group_localized, lang)?.value ?? trait.group ?? '其他'
    const key = `${group}::${name}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ group, name, sexual: trait.is_sexual === true })
  }
  return result
}

/**
 * 别名：优先同语言，其次任意语言；过滤掉与姓名/原名/罗马字重复的项，
 * 以及中文名角色身上纯 ASCII 的罗马字别名（对中文用户无信息量）。
 */
function mapAliases(
  aliases: ApiCharacterAlias[] | undefined,
  lang: string,
  context: { name: string; originalName: string; latin: string | null }
): string[] {
  if (!aliases || aliases.length === 0) return []

  const blocked = new Set(
    [context.name, context.originalName, context.latin ?? ''].filter(Boolean).map(normalizeForCompare)
  )
  const nameIsAscii = isAsciiOnly(context.name)
  const sameLang = aliases.filter((alias) => alias.lang === lang)
  const pool = [...sameLang, ...aliases.filter((alias) => alias.lang !== lang)]

  const seen = new Set<string>()
  const result: string[] = []
  for (const alias of pool) {
    const value = (alias.value ?? '').trim()
    if (!value) continue
    const key = normalizeForCompare(value)
    if (!key || blocked.has(key) || seen.has(key)) continue
    if (!nameIsAscii && isAsciiOnly(value)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

/** 详情条目 → 补全后面板人物 */
export function fromDetail(detail: ApiCharacterDetail, base: PanelCharacter, lang: string): PanelCharacter {
  const intro = pickIntro(detail.intros, lang)
  const merged: PanelCharacter = {
    ...base,
    name: base.name,
    imageUrl: detail.image?.url ?? base.imageUrl,
    figureUrl: detail.figure?.url ?? base.figureUrl,
    thumbhash: detail.image?.thumbhash ?? base.thumbhash,
    intro: intro?.text ?? '',
    introSource: intro?.source ?? null,
    introMachine: intro?.machine ?? false,
    gender: detail.gender ?? null,
    birthday: detail.birthday ?? null,
    heightCm: toNumberOrNull(detail.height_cm),
    weightKg: toNumberOrNull(detail.weight_kg),
    measurements: detail.measurements ?? null,
    bloodType: detail.blood_type ?? null,
    traits: mapTraits(detail.traits, lang),
    aliases: mapAliases(detail.aliases, lang, base),
    workCount: toNumberOrNull(detail.work_count),
    links: detail.links ?? [],
    enriched: true,
    enrichError: null
  }

  const detailName = pickLocalized(detail.localized, lang)
  const native = (detail.display_name ?? '').trim()
  if (!base.nameAlt && detailName && detailName.value && detailName.value !== merged.name) {
    merged.nameAlt = detailName.value
    merged.nameAltMachine = detailName.machine
  }
  if (!native && detailName) {
    merged.name = detailName.value
    merged.nameMachine = detailName.machine
  }
  return merged
}

/** 拉取单个角色详情并合并（N+1 的第二跳） */
export async function enrichCharacter(
  client: KungalClient,
  brief: ApiCharacterBrief,
  lang: string
): Promise<PanelCharacter> {
  const base = fromBrief(brief, lang)
  try {
    const detail = await client.get<ApiCharacterDetail>(
      `/catalog/characters/${encodeURIComponent(brief.id)}?include=${CHARACTER_INCLUDE}`
    )
    return fromDetail(detail, base, lang)
  } catch (error) {
    return {
      ...base,
      enriched: false,
      enrichError: error instanceof Error ? error.message : String(error)
    }
  }
}

/** 简单并发池：保持顺序，逐项回调进度 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  let done = 0

  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
      done += 1
      onProgress?.(done, items.length)
    }
  })

  await Promise.all(runners)
  return results
}

export interface ScrapeOptions {
  lang: string
  /** 深度刮削（含简介/属性）的角色数上限，0 表示只取列表 */
  maxCharacters: number
  onProgress?: (done: number, total: number) => void
}

/**
 * KunGalgame 的 work.characters 里，同一个角色经常有 2 条记录：
 * 一条是「规范条目」（`姫野原 鈴蘭`，带罗马字、立绘、声优），
 * 另一条是合并/别名条目（`姫野原鈴蘭`，只有简体译名）。
 * 直接渲染会出现同一人物两张卡片（用户报的「重复的刮削数据」），
 * 所以按「去空格/标点 + 小写」归一化后的名字分组，每组保留信息量最大的一条，
 * 其余条目的名字塞进保留者的 aliases，让详情里仍能看到「同名条目」的写法。
 */
interface DedupedBriefs {
  briefs: ApiCharacterBrief[]
  /** 保留下来的角色 id → 被合并掉的其它写法 */
  extraNames: Map<string, string[]>
  removed: number
}

function briefNameOf(brief: ApiCharacterBrief): string {
  const original = (brief.display_name ?? '').trim()
  if (original) return original
  for (const key of ['zh-Hans', 'zh-Hant', 'ja', 'en']) {
    const picked = pickLocalized(brief.localized, key)
    if (picked) return picked.value
  }
  return ''
}

/** 信息量打分：有罗马字（说明是规范条目）> 有头像 > 名字带空格 > 有声优 */
function briefRichness(brief: ApiCharacterBrief): number {
  let score = 0
  const ja = pickLocalized(brief.localized, 'ja')
  if (ja && isAsciiOnly(ja.value)) score += 4
  if (brief.image?.url) score += 2
  if (/\s/.test((brief.display_name ?? '').trim())) score += 1
  if ((brief.voices ?? []).length > 0) score += 1
  return score
}

function dedupeBriefs(briefs: ApiCharacterBrief[]): DedupedBriefs {
  const groups = new Map<string, { best: ApiCharacterBrief; names: string[]; seen: Set<string>; count: number }>()
  const order: string[] = []

  for (const brief of briefs) {
    const name = briefNameOf(brief)
    // 名字缺失时不参与合并（宁可多一张卡，也不把两个无名角色并成一个）
    const key = name ? normalizeForCompare(name) : `#id:${brief.id}`
    const existing = groups.get(key)
    if (!existing) {
      groups.set(key, { best: brief, names: name ? [name] : [], seen: new Set(name ? [name] : []), count: 1 })
      order.push(key)
      continue
    }
    existing.count += 1
    if (name && !existing.seen.has(name)) {
      existing.seen.add(name)
      existing.names.push(name)
    }
    if (briefRichness(brief) > briefRichness(existing.best)) existing.best = brief
  }

  const kept: ApiCharacterBrief[] = []
  const extraNames = new Map<string, string[]>()
  let removed = 0
  for (const key of order) {
    const group = groups.get(key)
    if (!group) continue
    kept.push(group.best)
    const others = group.names.filter((name) => name !== briefNameOf(group.best))
    if (others.length > 0) extraNames.set(String(group.best.id), others)
    removed += Math.max(0, group.count - 1)
  }
  return { briefs: kept, extraNames, removed }
}

/**
 * 刮削一部作品的人物数据。
 * 关键点：
 *  - 1 次 work 详情拿名单（含头像、声优、定位）；
 *  - 按「主角 → 主要 → 配角」排序后，仅对前 maxCharacters 个发详情请求（控制 N+1 成本）；
 *  - 单个角色详情失败不影响整批，错误写进 enrichError。
 */
export async function scrapeCharacters(
  client: KungalClient,
  work: ApiWork,
  options: ScrapeOptions
): Promise<CharacterPanelData> {
  const lang = options.lang
  const warnings: string[] = []
  const briefs = (work.characters ?? []).filter((item) => Boolean(item && item.id))
  // 先合并同名重复条目，再排序/截断：否则「深度刮削人数」会被重复条目占名额，
  // 卡片墙里也会出现同一个人两张卡（这就是用户报的「重复的刮削数据」）。
  const deduped = dedupeBriefs(briefs)

  const sorted = [...deduped.briefs].sort((a, b) => {
    const roleDiff = roleRank((a.roster_role ?? 'appears').toString()) - roleRank((b.roster_role ?? 'appears').toString())
    if (roleDiff !== 0) return roleDiff
    const spoilerA = a.spoiler === 'none' || !a.spoiler ? 0 : 1
    const spoilerB = b.spoiler === 'none' || !b.spoiler ? 0 : 1
    if (spoilerA !== spoilerB) return spoilerA - spoilerB
    return (a.display_name ?? '').localeCompare(b.display_name ?? '')
  })

  const limit = Math.max(0, Math.min(options.maxCharacters, sorted.length))
  const deepTargets = sorted.slice(0, limit)
  const rest = sorted.slice(limit)

  const enriched = await mapWithConcurrency(
    deepTargets,
    ENRICH_CONCURRENCY,
    (brief) => enrichCharacter(client, brief, lang),
    options.onProgress
  )

  const failed = enriched.filter((character) => character.enriched === false && character.enrichError)
  if (failed.length > 0) {
    warnings.push(`${failed.length} 个人物的详情刮削失败：${failed[0].enrichError ?? ''}`)
  }
  if (deduped.removed > 0) {
    warnings.push(`已合并 ${deduped.removed} 个同名重复条目（KunGalgame 里同一角色常有多条记录）`)
  }
  if (rest.length > 0) {
    warnings.push(`仅深度刮削前 ${limit} 位人物（主角优先），其余 ${rest.length} 位仅显示列表信息；可在设置里调大「深度刮削人数」`)
  }

  const name = pickName(work, lang)
  const originalName = (work.display_name ?? '').trim()

  return {
    schemaVersion: 1,
    source: 'kungal',
    workId: String(work.id),
    workName: name.value,
    workOriginalName: originalName,
    workLatin: work.latin ?? null,
    coverUrl: work.cover?.url ?? null,
    bannerUrl: work.banner?.url ?? null,
    lang,
    fetchedAt: Date.now(),
    total: sorted.length,
    enrichedCount: enriched.filter((character) => character.enriched).length,
    truncated: rest.length > 0,
    duplicates: deduped.removed,
    characters: [...enriched, ...rest.map((brief) => fromBrief(brief, lang))].map((character) => {
      const extra = deduped.extraNames.get(character.id)
      if (!extra || extra.length === 0) return character
      const aliases = [...character.aliases]
      for (const alias of extra) {
        if (!alias || alias === character.name || alias === character.originalName) continue
        if (aliases.indexOf(alias) < 0) aliases.push(alias)
      }
      return { ...character, aliases }
    }),
    warnings
  }
}
