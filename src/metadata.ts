import type { IPluginAPI } from 'vnite-plugin-sdk'
import type { CharacterPanelData } from './kungal/characters'

/**
 * 把人物数据写进 Vnite 游戏库的原生字段。
 *
 * SDK 没有渲染进程 UI 插槽，唯一能让「游戏详情页」直接看到内容的位置就是
 * gameDoc.metadata —— 其中 `extra: { key, value: string[] }[]` 是详情页「附加信息」区，
 * 可以写入任意 key（官方预定义只有 director/scenario/illustration/music/engine，
 * kungal-catalog 也是用 rating_* 这类自定义 key 写的）。这里用两个 key：
 *   - characters        每人一行：姓名（定位）· CV
 *   - character_panel   数据源摘要：作品名 · 人数 · 抓取时间
 * 只动这两个 key，其余 extra 原样保留。
 */

export const EXTRA_KEY_CHARACTERS = 'characters'
export const EXTRA_KEY_PANEL = 'character_panel'

export interface MetadataSyncResult {
  written: number
  characters: string[]
}

function formatVoice(character: CharacterPanelData['characters'][number]): string {
  const voices = character.voices.map((voice) => voice.name).filter(Boolean)
  if (voices.length === 0) return ''
  return ` · CV: ${voices.slice(0, 3).join(' / ')}`
}

/** 生成「附加信息」行；超出 maxLines 截断并补省略说明 */
export function buildCharacterLines(panel: CharacterPanelData, maxLines = 40): string[] {
  const list = panel.characters.slice(0, Math.max(0, maxLines))
  const lines = list.map((character) => {
    const alias = character.aliases[0] ? `（${character.aliases[0]}）` : ''
    const name = `${character.name}${alias}`
    const role = character.roleLabel ? `【${character.roleLabel}】` : ''
    return `${role}${name}${formatVoice(character)}`
  })

  const hidden = panel.characters.length - list.length
  if (hidden > 0) lines.push(`…另有 ${hidden} 位人物（见人物面板）`)
  return lines
}

export function buildPanelSummary(panel: CharacterPanelData): string {
  const time = new Date(panel.fetchedAt)
  const stamp = `${time.getFullYear()}-${String(time.getMonth() + 1).padStart(2, '0')}-${String(
    time.getDate()
  ).padStart(2, '0')} ${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
  const deep = panel.enrichedCount > 0 ? `，深度补全 ${panel.enrichedCount} 位` : ''
  return `KunGalgame #${panel.workId} · ${panel.total} 位人物${deep} · ${stamp}`
}

interface GameExtraEntry {
  key: string
  value: string[]
}

/** 写入 GameDB.metadata.extra（Vnite 详情页侧栏） */
export async function syncCharactersToMetadata(
  api: IPluginAPI,
  gameId: string,
  panel: CharacterPanelData,
  maxLines = 40
): Promise<MetadataSyncResult> {
  const game = await api.GameDB.getGame(gameId)
  if (!game) return { written: 0, characters: [] }

  const existing: GameExtraEntry[] = Array.isArray(game.metadata?.extra)
    ? (game.metadata.extra as GameExtraEntry[]).map((entry) => ({ key: entry.key, value: [...(entry.value ?? [])] }))
    : []

  const characters = buildCharacterLines(panel, maxLines)
  const merged: GameExtraEntry[] = existing.filter(
    (entry) => entry.key !== EXTRA_KEY_CHARACTERS && entry.key !== EXTRA_KEY_PANEL
  )
  merged.push({ key: EXTRA_KEY_CHARACTERS, value: characters })
  merged.push({ key: EXTRA_KEY_PANEL, value: [buildPanelSummary(panel)] })

  await (api.GameDB as any).setGame(gameId, {
    metadata: { ...(game.metadata ?? {}), extra: merged }
  })

  return { written: characters.length, characters }
}

/**
 * 撤销写入：把两个自定义 key 从 extra 里摘掉（关闭 syncToMetadata 后用）。
 * 其余附加信息字段保持不动。
 */
export async function clearCharactersMetadata(api: IPluginAPI, gameId: string): Promise<boolean> {
  const game = await api.GameDB.getGame(gameId)
  if (!game) return false
  const existing: GameExtraEntry[] = Array.isArray(game.metadata?.extra)
    ? (game.metadata.extra as GameExtraEntry[])
    : []
  const kept = existing.filter(
    (entry) => entry.key !== EXTRA_KEY_CHARACTERS && entry.key !== EXTRA_KEY_PANEL
  )
  if (kept.length === existing.length) return false
  await (api.GameDB as any).setGame(gameId, {
    metadata: { ...(game.metadata ?? {}), extra: kept }
  })
  return true
}
