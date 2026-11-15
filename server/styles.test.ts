/**
 * 内置风格库的数据检查：每个风格都符合风格库的格式（名字、说明、英文描述、提示词的长度限制），id 不重复，游戏和网页各一批，
 * 3D 模型风格有约束要点；每个内置风格都有打包的参考图。
 * 运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PROMPT_CATEGORIES, SavedStyle } from '../shared/style-types.ts'
import { BUILTIN_STYLES, isBuiltinStyle } from '../shared/styles.ts'
import { DEFAULT_MODEL_STYLE } from '../shared/style/model-styles.ts'
import { styleBrief } from '../shared/style/rules-text.ts'
import { existsSync } from 'node:fs'

test('内置风格都符合风格库的格式，id 和名字不重复', () => {
  for (const s of BUILTIN_STYLES) {
    const r = SavedStyle.safeParse(s)
    assert.ok(r.success, `${s.name}：${r.success ? '' : r.error.message}`)
    assert.ok(isBuiltinStyle(s.id) && s.builtin)
    // 参考图随程序打包（web/src/components/ui/style-thumb.tsx 按 id 找）
    assert.ok(existsSync(new URL(`../web/src/assets/style-refs/${s.id}.webp`, import.meta.url)), `${s.name} 没有参考图`)
    if (s.kind === 'model') continue
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
  for (const kind of ['game', 'web', 'model'] as const) {
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

test('3D 模型风格：有约束要点和验收项，默认是「通用」，名字和要点里不写具体游戏名', () => {
  const models = BUILTIN_STYLES.filter((x) => x.kind === 'model')
  assert.equal(models[0]?.id, DEFAULT_MODEL_STYLE)
  assert.equal(models[0]?.name, '通用')
  for (const s of models) {
    assert.ok(s.rules.length >= 5, `${s.name} 的约束要点太少`)
    assert.ok(
      s.rules.some((r) => r.group === 'check'),
      `${s.name} 缺少「验收」`,
    )
    assert.doesNotMatch(`${s.name}${s.summary}${s.rules.map((r) => r.text).join('')}`, /《|原神|塞尔达|崩坏/)
  }
})

test('风格拼成给 Agent 的说明：按约束组的顺序，验收组写明质检时逐条检查；中途换风格只管之后的步骤', () => {
  const s = BUILTIN_STYLES.find((x) => x.id === 'builtin-model-anime')!
  const text = styleBrief(s)
  assert.match(text, /^## 模型风格：日式二次元卡通/)
  assert.ok(text.indexOf('### 造型') < text.indexOf('### 材质与着色'))
  assert.ok(text.indexOf('### 材质与着色') < text.indexOf('### 描边'))
  assert.match(text, /### 验收（质检时逐条检查并给出截图）/)
  assert.match(styleBrief(s, true), /^## 模型风格改成了：日式二次元卡通[\s\S]*已经建好的部分保持原样/)
})
