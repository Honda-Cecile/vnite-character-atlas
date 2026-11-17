/**
 * KunGalgame Public API v2 的响应类型（只声明本插件真正用到的字段）。
 * 所有 localization 值既可能是 { value, is_machine } 也可能是裸字符串，这里统一用 LocalizedValue 兼容。
 */

export interface LocalizedValue {
  value: string
  is_machine?: boolean
}

export type LocalizedMap = Record<string, LocalizedValue | string>

export interface ApiImage {
  url?: string | null
  hash?: string | null
  width?: number | null
  height?: number | null
  thumbhash?: string | null
  sexual?: number | null
  violence?: number | null
  source?: string | null
}

export interface ApiCreditName {
  object?: string
  id?: string
  display_name?: string
  latin?: string | null
  lang?: string | null
  localized?: LocalizedMap
  person_id?: string | null
}

export interface ApiCharacterBrief {
  object?: string
  id: string
  display_name?: string
  latin?: string | null
  localized?: LocalizedMap
  roster_role?: string | null
  spoiler?: string | null
  identity?: string | null
  voices?: ApiCreditName[]
  image?: ApiImage | null
  figure?: ApiImage | null
}

export interface ApiCharacterTrait {
  object?: string
  id?: string
  display_name?: string
  group?: string | null
  localized?: LocalizedMap
  group_localized?: LocalizedMap
  spoiler?: string | null
  is_sexual?: boolean | null
  is_lie?: boolean | null
}

export interface ApiCharacterIntro {
  lang?: string | null
  value?: string | null
  is_machine?: boolean | null
  source?: string | null
}

export interface ApiCharacterAlias {
  lang?: string | null
  value?: string | null
  alias_kind?: string | null
  is_machine?: boolean | null
}

export interface ApiCharacterLink {
  source?: string | null
  url?: string | null
  is_identity?: boolean | null
  page_id?: string | null
}

export interface ApiMeasurements {
  bust_cm?: number | null
  waist_cm?: number | null
  hip_cm?: number | null
  cup?: string | null
}

export interface ApiCharacterDetail extends ApiCharacterBrief {
  lang?: string | null
  gender?: string | null
  birthday?: string | null
  height_cm?: number | null
  weight_kg?: number | null
  measurements?: ApiMeasurements | null
  blood_type?: string | null
  traits?: ApiCharacterTrait[]
  intros?: ApiCharacterIntro[]
  aliases?: ApiCharacterAlias[]
  links?: ApiCharacterLink[]
  work_count?: number | null
}

export interface ApiWork {
  object?: string
  id: string
  medium?: string | null
  display_name?: string
  latin?: string | null
  localized?: LocalizedMap
  olang?: string | null
  content_rating?: string | null
  release_date?: string | null
  cover?: ApiImage | null
  banner?: ApiImage | null
  characters?: ApiCharacterBrief[]
}

export interface ApiSearchResult {
  object?: string
  target_object?: string
  id: string
  display_name?: string
  /** 搜索面通常不带 latin，但上游偶尔会回，保留可选位以便参与标题比对 */
  latin?: string | null
  localized?: LocalizedMap
  content_rating?: string | null
  sources?: Array<{ source?: string; external_id?: string; url?: string }>
}

export interface ApiListResponse<T> {
  object?: string
  items?: T[]
  total?: number
  limit?: number
  offset?: number
}
