/**
 * 数据层探针（离线，不联网）：
 *   1. 人物详情请求必须带 `spoiler=major` —— 否则上游只回「无剧透」标签；
 *   2. 标签要带自己的剧透等级（none / minor / major），is_lie 的假标签照旧丢掉；
 *   3. 同名标签同时出现在 none 与 major 时，只留 none 那条；
 *   4. 作品匹配要把「原名」也算进候选：译名搜不到时用原名照样能定位。
 *
 *   node scripts/probe-traits.js
 */
const path = require('path')

const pluginModule = require('../dist/index.js')
const { scrapeVndbCharacters } = pluginModule // 只是确保 dist 加载成功
void scrapeVndbCharacters

const { scrapeCharacters } = require('../dist/index.js')

let failures = 0
function check(name, ok, detail) {
  if (ok) console.log(`✅ ${name}${detail ? ' | ' + detail : ''}`)
  else {
    failures++
    console.log(`❌ ${name}${detail ? ' | ' + detail : ''}`)
  }
}

/* ---------- 1. 标签剧透分级 ---------- */

const DETAIL_PATH_HITS = []
const DETAIL = {
  object: 'character',
  id: '1',
  display_name: '本多 世枝瑠',
  localized: { 'zh-Hans': { value: '本多世枝瑠' } },
  traits: [
    { object: 'trait', id: '10', display_name: '妹妹', group: '角色身份',
      group_localized: { 'zh-Hans': { value: '角色身份' } }, spoiler: 'none', is_sexual: false, is_lie: false },
    { object: 'trait', id: '11', display_name: '实妹', group: '角色身份',
      group_localized: { 'zh-Hans': { value: '角色身份' } }, spoiler: 'major', is_sexual: false, is_lie: false },
    { object: 'trait', id: '12', display_name: '青梅竹马', group: '关系',
      group_localized: { 'zh-Hans': { value: '关系' } }, spoiler: 'minor', is_sexual: false, is_lie: false },
    // 同一组同名：none 与 major 各一条 —— 去重后应只留 none
    { object: 'trait', id: '13', display_name: '妹妹', group: '角色身份',
      group_localized: { 'zh-Hans': { value: '角色身份' } }, spoiler: 'major', is_sexual: false, is_lie: false },
    // 谎言标签：必须被丢掉
    { object: 'trait', id: '14', display_name: '冒牌设定', group: '其他', spoiler: 'none', is_lie: true }
  ]
}

const ROSTER_BRIEF = {
  object: 'character',
  id: '1',
  display_name: '本多 世枝瑠',
  roster_role: 'main',
  spoiler: 'none'
}

const WORK = {
  object: 'work',
  id: '4242',
  display_name: '空のつくりかた',
  localized: { 'zh-Hans': { value: '天空的作法' } },
  characters: [ROSTER_BRIEF]
}

const client = {
  async get(pathname) {
    if (pathname.indexOf('/catalog/characters/') === 0) {
      DETAIL_PATH_HITS.push(pathname)
      return DETAIL
    }
    throw new Error('unexpected path ' + pathname)
  }
}

async function testTraits() {
  const panel = await scrapeCharacters(client, WORK, {
    lang: 'zh-Hans',
    maxCharacters: 5,
    onProgress: () => {}
  })
  const character = panel.characters[0]
  const traits = (character && character.traits) || []

  check(
    '详情请求带 spoiler=major',
    DETAIL_PATH_HITS.length > 0 && DETAIL_PATH_HITS[0].indexOf('spoiler=major') >= 0,
    DETAIL_PATH_HITS[0] || '(没有请求)'
  )

  const byName = {}
  for (const trait of traits) byName[trait.name] = trait

  check('标签数量（5 条原始 → 去重 + 丢 is_lie 后 3）', traits.length === 3, `实际 ${traits.length}：${traits.map((t) => `${t.name}:${t.spoiler}`).join(', ')}`)
  check('无剧透标签 spoiler=none', byName['妹妹'] && byName['妹妹'].spoiler === 'none', JSON.stringify(byName['妹妹'] || null))
  check('重度剧透标签 spoiler=major', byName['实妹'] && byName['实妹'].spoiler === 'major', JSON.stringify(byName['实妹'] || null))
  check('轻微剧透标签 spoiler=minor', byName['青梅竹马'] && byName['青梅竹马'].spoiler === 'minor', JSON.stringify(byName['青梅竹马'] || null))
  check('is_lie 假标签已丢弃', !byName['冒牌设定'])
  check('panel.schemaVersion=2', panel.schemaVersion === 2, String(panel.schemaVersion))
}

/* ---------- 2. 原名参与作品匹配 ---------- */

const resolve = require('../dist/index.js')
const SEARCH_HITS = []

const resolveClient = {
  async get(pathname) {
    SEARCH_HITS.push(pathname)
    if (pathname.indexOf('/catalog/search') === 0) {
      const q = decodeURIComponent(pathname.split('q=')[1].split('&')[0])
      // 只有原名（日文）能被搜到；译名“天空的作法”上游没有
      if (q.indexOf('空のつくりかた') >= 0) {
        return { object: 'list', items: [{ object: 'work', target_object: 'work', id: '4242', display_name: '空のつくりかた' }] }
      }
      return { object: 'list', items: [] }
    }
    if (pathname.indexOf('/catalog/works/4242') === 0) return WORK
    throw new Error('unexpected path ' + pathname)
  }
}

async function testResolve() {
  const resolver = resolve.resolveWorkId
  if (typeof resolver !== 'function') {
    check('dist 里拿到 resolveWorkId', false, '导出缺失')
    return
  }
  const resolved = await resolver(resolveClient, {
    name: '天空的作法', // 译名，上游搜不到
    names: ['空のつくりかた'], // 原名，能搜到
    vndbId: null,
    relatedSites: []
  })
  check('译名搜不到时用原名命中', resolved && String(resolved.workId) === '4242', JSON.stringify({ workId: resolved && resolved.workId, matchedBy: resolved && resolved.matchedBy, query: resolved && resolved.query }))
  check('命中方式=search', resolved && resolved.matchedBy === 'search', resolved && resolved.matchedBy)
  check('确实先查了译名、再查原名', SEARCH_HITS.length >= 2, SEARCH_HITS.map((p) => decodeURIComponent(p.split('q=')[1] || '')).join(' → '))
}

;(async function () {
  await testTraits()
  await testResolve()
  console.log(failures === 0 ? '\n✅ 数据层全部通过' : `\n❌ ${failures} 项未通过`)
  process.exit(failures === 0 ? 0 : 1)
})()
