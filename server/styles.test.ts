/**
 * 内置风格库的数据检查：每个风格都符合风格库的格式（名字、说明、英文描述、提示词的长度限制），id 不重复，游戏和网页各一批。
 * 运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROMPT_CATEGORIES, SavedStyle } from '../shared/design.ts'
import { BUILTIN_STYLES, isBuiltinStyle } from '../shared/styles.ts'

test('内置风格都符合风格库的格式，id 和名字不重复', () => {
  for (const s of BUILTIN_STYLES) {
    const r = SavedStyle.safeParse(s)
    assert.ok(r.success, `${s.name}：${r.success ? '' : r.error.message}`)
    assert.ok(isBuiltinStyle(s.id) && s.builtin)
    assert.ok(s.en.length >= 200, `${s.name} 的英文描述要写够（画风、配色、材质、光影）`)
    assert.ok(s.prompts.length >= 5, `${s.name} 的提示词要拆成几条要点`)
    // 每个风格都有「避免」，免得生成偏掉；分类都是认得的
    assert.ok(
      s.prompts.some((x) => x.category === 'avoid'),
      `${s.name} 缺少「避免」`,
    )
    assert.ok(s.prompts.every((x) => PROMPT_CATEGORIES.includes(x.category) && x.zh && x.en))
  }
  assert.equal(new Set(BUILTIN_STYLES.map((s) => s.id)).size, BUILTIN_STYLES.length)
  for (const kind of ['game', 'web'] as const) {
    const names = BUILTIN_STYLES.filter((s) => s.kind === kind).map((s) => s.name)
    assert.ok(names.length >= 10, `${kind} 的内置风格不少于 10 个`)
    assert.equal(new Set(names).size, names.length, `${kind} 的风格名字不重复`)
  }
})

test('游戏风格不写网页的东西，网页风格不写游戏的东西', () => {
  for (const s of BUILTIN_STYLES.filter((x) => x.kind === 'web'))
    assert.doesNotMatch(s.en, /\bgame (UI|HUD)\b|\bRPG\b/i, `${s.name} 是网页风格`)
  for (const s of BUILTIN_STYLES.filter((x) => x.kind === 'game'))
    assert.doesNotMatch(s.en, /\bweb(site| page)?\b|\bSaaS\b|\bhero section\b/i, `${s.name} 是游戏风格`)
})
