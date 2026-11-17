import type { IPluginAPI } from 'vnite-plugin-sdk'
import type { CharacterPanelData, PanelCharacter } from './kungal/characters'
import { kvGet, kvSet } from './pluginKv'

/**
 * 用户对某个作品人物名单的「个人修正」。
 *
 * 为什么单独存一层而不是直接改缓存：
 *  - 缓存会被 TTL 刷新、被「重新刮削」整份覆盖，直接把编辑写进缓存等于白改一次；
 *  - 删除也一样，重新刮削会把角色又拉回来。
 * 因此把「删掉的 id」和「改过的字段」按 gameId 存进 PluginDB，
 * 每次对外发数据（IPC / 原生标签页）时再叠加到刮削结果上。
 *
 * 键：`charpanel:v1:overrides:<gameId>`
 */

const KEY_PREFIX = 'charpanel:v1:overrides'

export interface CharacterEdit {
  name?: string
  originalName?: string
  nameAlt?: string
  roleLabel?: string
  cv?: string
  gender?: string
  birthday?: string
  heightCm?: string
  weightKg?: string
  measurements?: string
  bloodType?: string
  intro?: string
  aliases?: string
  updatedAt?: number
}

export interface OverrideDoc {
  schemaVersion: 1
  removed: string[]
  edited: Record<string, CharacterEdit>
  updatedAt: number
}

function emptyDoc(): OverrideDoc {
  return { schemaVersion: 1, removed: [], edited: {}, updatedAt: 0 }
}

function key(gameId: string): string {
  return `${KEY_PREFIX}:${gameId}`
}

function clean(value: unknown): string {
  return String(value === undefined || value === null ? '' : value).trim()
}

function toNumber(value: string): number | null {
  const text = clean(value).replace(/[^\d.]/g, '')
  if (!text) return null
  const num = Number(text)
  return Number.isFinite(num) ? num : null
}

/** `86/57/82`、`B86 W57 H82`、`B86/W57/H82/E` 都吃 */
function toMeasurements(value: string): PanelCharacter['measurements'] {
  const text = clean(value)
  if (!text) return null
  const nums: number[] = []
  const re = /\d+(?:\.\d+)?/g
  let hit: RegExpExecArray | null
  while ((hit = re.exec(text)) !== null && nums.length < 3) nums.push(Number(hit[0]))
  const cup = (text.match(/[A-Za-z]\s*(?:cup|罩杯)?\s*$/i) || [])[0]
  if (!nums.length && !cup) return null
  return {
    bust_cm: nums[0] ?? null,
    waist_cm: nums[1] ?? null,
    hip_cm: nums[2] ?? null,
    cup: cup ? cup.replace(/\s*(?:cup|罩杯)\s*$/i, '').toUpperCase() : null
  }
}

function splitAliases(value: string): string[] {
  return clean(value)
    .split(/[,，、;；|]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

/** 把一条编辑记录叠到刮削结果上（只覆盖用户显式改过的字段） */
function applyEdit(character: PanelCharacter, edit: CharacterEdit): PanelCharacter {
  const next: PanelCharacter = { ...character }
  if (edit.name !== undefined && clean(edit.name)) {
    next.name = clean(edit.name)
    // 名字改了以后「机器翻译」标记就没有意义了
    next.nameMachine = false
  }
  if (edit.originalName !== undefined) next.originalName = clean(edit.originalName)
  if (edit.nameAlt !== undefined) {
    next.nameAlt = clean(edit.nameAlt)
    next.nameAltMachine = false
  }
  if (edit.roleLabel !== undefined) next.roleLabel = clean(edit.roleLabel)
  if (edit.cv !== undefined) {
    next.voices = clean(edit.cv) ? [{ name: clean(edit.cv), lang: null }] : []
  }
  if (edit.gender !== undefined) next.gender = clean(edit.gender) || null
  if (edit.birthday !== undefined) next.birthday = clean(edit.birthday) || null
  if (edit.heightCm !== undefined) next.heightCm = toNumber(edit.heightCm)
  if (edit.weightKg !== undefined) next.weightKg = toNumber(edit.weightKg)
  if (edit.bloodType !== undefined) next.bloodType = clean(edit.bloodType) || null
  if (edit.measurements !== undefined) next.measurements = toMeasurements(edit.measurements)
  if (edit.intro !== undefined) {
    next.intro = clean(edit.intro)
    next.introMachine = false
    next.introSource = next.intro ? next.introSource || '手动编辑' : null
  }
  if (edit.aliases !== undefined) next.aliases = splitAliases(edit.aliases)
  return next
}

export class CharacterOverrides {
  private readonly api: IPluginAPI
  private readonly log: (message: string, error?: unknown) => void
  private readonly memory = new Map<string, OverrideDoc>()

  constructor(api: IPluginAPI, log: (message: string, error?: unknown) => void) {
    this.api = api
    this.log = log
  }

  private async doc(gameId: string): Promise<OverrideDoc> {
    const cached = this.memory.get(gameId)
    if (cached) return cached
    const stored = await kvGet<OverrideDoc | null>(this.api, key(gameId), null)
    const doc: OverrideDoc =
      stored && typeof stored === 'object'
        ? {
            schemaVersion: 1,
            removed: Array.isArray(stored.removed) ? stored.removed.map(String) : [],
            edited: stored.edited && typeof stored.edited === 'object' ? stored.edited : {},
            updatedAt: Number(stored.updatedAt) || 0
          }
        : emptyDoc()
    this.memory.set(gameId, doc)
    return doc
  }

  private async save(gameId: string, doc: OverrideDoc): Promise<void> {
    doc.updatedAt = Date.now()
    this.memory.set(gameId, doc)
    try {
      await kvSet(this.api, key(gameId), doc)
    } catch (error) {
      this.log(`保存人物修正失败 (${gameId})`, error)
    }
  }

  /** 叠加删除/编辑后的名单（total 同步扣掉被删掉的人） */
  async apply(gameId: string, data: CharacterPanelData): Promise<CharacterPanelData> {
    const doc = await this.doc(gameId)
    if (!doc.removed.length && !Object.keys(doc.edited).length) return data
    const removed = new Set(doc.removed)
    const characters: PanelCharacter[] = []
    for (const character of data.characters) {
      if (removed.has(String(character.id))) continue
      const edit = doc.edited[String(character.id)]
      characters.push(edit ? applyEdit(character, edit) : character)
    }
    const enrichedCount = characters.filter((item) => item.enriched).length
    return { ...data, characters, total: characters.length, enrichedCount }
  }

  async remove(gameId: string, id: string): Promise<{ ok: boolean; removed: number }> {
    const doc = await this.doc(gameId)
    const target = String(id)
    if (!target) return { ok: false, removed: doc.removed.length }
    if (doc.removed.indexOf(target) < 0) doc.removed.push(target)
    delete doc.edited[target]
    await this.save(gameId, doc)
    return { ok: true, removed: doc.removed.length }
  }

  async update(gameId: string, id: string, patch: CharacterEdit): Promise<boolean> {
    const doc = await this.doc(gameId)
    const target = String(id)
    if (!target) return false
    doc.edited[target] = { ...(doc.edited[target] || {}), ...patch, updatedAt: Date.now() }
    // 编辑一个被删掉的角色 = 重新把它请回来
    const index = doc.removed.indexOf(target)
    if (index >= 0) doc.removed.splice(index, 1)
    await this.save(gameId, doc)
    return true
  }

  async reset(gameId: string): Promise<void> {
    this.memory.set(gameId, emptyDoc())
    await this.save(gameId, emptyDoc())
  }

  /** 导出用：把若干作品的修正原样交出去（空修正不占体积） */
  async exportDocs(gameIds: string[]): Promise<Record<string, OverrideDoc>> {
    const out: Record<string, OverrideDoc> = {}
    for (const gameId of gameIds) {
      if (!gameId) continue
      const doc = await this.doc(gameId)
      if (!doc.removed.length && !Object.keys(doc.edited).length) continue
      out[gameId] = { ...doc, removed: doc.removed.slice(), edited: { ...doc.edited } }
    }
    return out
  }

  /** 导入用：整体覆盖某部作品的修正（导出包的忠实还原） */
  async importDocs(docs: Record<string, OverrideDoc>): Promise<number> {
    let count = 0
    for (const gameId of Object.keys(docs || {})) {
      if (!gameId) continue
      const raw = docs[gameId]
      if (!raw || typeof raw !== 'object') continue
      const doc: OverrideDoc = {
        schemaVersion: 1,
        removed: Array.isArray(raw.removed) ? raw.removed.map(String) : [],
        edited: raw.edited && typeof raw.edited === 'object' ? { ...raw.edited } : {},
        updatedAt: Number(raw.updatedAt) || Date.now()
      }
      await this.save(gameId, doc)
      count += 1
    }
    return count
  }

  /**
   * 清空全部修正：内存里记住的每部作品都要落盘一份空文档，
   * 否则下次读还是会从 PluginDB 里把那部作品的修正捞回来。
   */
  async resetAll(gameIds: string[]): Promise<void> {
    const ids = Array.from(new Set(gameIds.concat(Array.from(this.memory.keys()))))
    this.memory.clear()
    for (const gameId of ids) {
      if (!gameId) continue
      this.memory.set(gameId, emptyDoc())
      await this.save(gameId, emptyDoc())
    }
  }
}
