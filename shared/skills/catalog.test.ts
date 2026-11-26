/**
 * 技能由面板推送（ADR 0083）：技能目录、条件匹配、生成的情境规则、推送文字、用户改动的合并。
 * 运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { ModelSupportData, resolveSupport } from '../models/support.ts'
import type { HookFacts } from '../hooks/index.ts'
import { pickSituational, type SituationCtx } from '../hooks/situational.ts'
import { BUILTIN_SKILLS, alwaysSkills, builtinSkillSource, pluginSkillSource, skillCatalog } from './catalog.ts'
import { commandMatches } from './commands.ts'
import { skillPathText, skillPushText } from './push-text.ts'
import { patchOverride } from './rows.ts'
import { skillRules } from './rules.ts'
import { pathsInText, whenMatchesCall, whenMatchesLaunch, type SkillCallFacts } from './when.ts'

const root = path.resolve(import.meta.dirname, '../..')
const call = (o: Partial<SkillCallFacts>): SkillCallFacts => ({ kind: 'any', tool: '', paths: [], command: '', ...o })

test('技能目录：skills/ 下每个自带技能都有一行，不自动推的几个默认没有条件、不开', () => {
  const dirs = readdirSync(path.join(root, 'skills'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => readdirSync(path.join(root, 'skills', d.name)))
    .sort()
  assert.deepEqual(BUILTIN_SKILLS.map((s) => s.name).sort(), dirs)
  for (const n of ['brainstorming', 'grilling', 'openspec', 'task-records']) {
    const s = BUILTIN_SKILLS.find((x) => x.name === n)!
    assert.equal(s.autoPush, false, n)
    assert.deepEqual(s.when, [], n)
  }
  // 特化技能先推它扩展的通用技能
  assert.equal(BUILTIN_SKILLS.find((x) => x.name === 'ue-project-structure')!.base, 'project-structure')
})

test('技能条件：改文件按通配认路径，Windows 绝对路径、反斜杠也认；读文件不算改', () => {
  const lua = { kind: 'edit' as const, value: '**/*.lua' }
  const win = 'G:\\Project\\Content\\Script\\Module\\s_BW_CG_ClinkGlassesSystem.lua'
  assert.ok(whenMatchesCall(lua, call({ kind: 'edit', paths: [win] }), 'tool.before'))
  assert.ok(whenMatchesCall(lua, call({ kind: 'edit', paths: ['Script/a.lua'] }), 'tool.before'))
  assert.equal(whenMatchesCall(lua, call({ kind: 'read', paths: ['Script/a.lua'] }), 'tool.before'), false)
  assert.equal(whenMatchesCall(lua, call({ kind: 'edit', paths: ['src/a.ts'] }), 'tool.before'), false)
  // 花括号和 | 都能写几种
  const cpp = BUILTIN_SKILLS.find((x) => x.name === 'cpp-code-style')!.when[0]
  assert.ok(
    whenMatchesCall(cpp, call({ kind: 'edit', paths: ['C:\\UE\\Source\\Foo\\Private\\Foo.cpp'] }), 'tool.before'),
  )
  assert.ok(whenMatchesCall(cpp, call({ kind: 'edit', paths: ['Source/Foo/Public/Foo.h'] }), 'tool.before'))
  const docs = BUILTIN_SKILLS.find((x) => x.name === 'project-documentation')!.when[0]
  assert.ok(whenMatchesCall(docs, call({ kind: 'edit', paths: ['D:\\repo\\AGENTS.md'] }), 'tool.before'))
  assert.ok(whenMatchesCall(docs, call({ kind: 'edit', paths: ['docs/modules/a/README.md'] }), 'tool.before'))
  assert.equal(whenMatchesCall(docs, call({ kind: 'edit', paths: ['notes/todo.md'] }), 'tool.before'), false)
})

test('技能条件：命令按类别认（程序名带路径、.exe、环境变量前缀都认），失败条件只在工具后、失败时对上', () => {
  assert.ok(commandMatches('vcs', 'git status --short'))
  assert.ok(commandMatches('vcs', 'cd x && "C:\\Program Files\\Perforce\\p4.exe" opened'))
  assert.ok(commandMatches('test', 'CI=1 npm test -- --grep a'))
  assert.ok(commandMatches('test', 'node --test server/a.test.ts'))
  assert.ok(commandMatches('test', 'npx vitest run'))
  assert.equal(commandMatches('test', 'npm install'), false)
  assert.equal(commandMatches('vcs', 'echo git'), false)
  assert.ok(commandMatches('cargo|make', 'make -j8'))

  const failed = { kind: 'failed' as const, value: 'test' }
  const run = (f: boolean) => call({ kind: 'shell', command: 'npm test', failed: f })
  assert.ok(whenMatchesCall(failed, run(true), 'tool.after'))
  assert.equal(whenMatchesCall(failed, run(false), 'tool.after'), false)
  assert.equal(whenMatchesCall(failed, run(true), 'tool.before'), false)
})

test('技能条件：收尾阶段看收尾工具，改过文件的另算；工具名通配', () => {
  const fin = { kind: 'phase' as const, value: 'finishing' }
  const edited = { kind: 'phase' as const, value: 'finishing-edited' }
  assert.ok(whenMatchesCall(fin, call({ kind: 'panel', tool: 'end_turn' }), 'tool.before'))
  assert.ok(whenMatchesCall(fin, call({ kind: 'panel', tool: 'submit_review' }), 'tool.before'))
  assert.equal(whenMatchesCall(fin, call({ kind: 'panel', tool: 'set_plan' }), 'tool.before'), false)
  assert.equal(whenMatchesCall(edited, call({ kind: 'panel', tool: 'end_turn' }), 'tool.before'), false)
  assert.ok(whenMatchesCall(edited, call({ kind: 'panel', tool: 'end_turn', edited: true }), 'tool.before'))
  const tool = { kind: 'tool' as const, value: 'blender_*' }
  assert.ok(whenMatchesCall(tool, call({ tool: 'blender_scene' }), 'tool.before'))
  assert.equal(whenMatchesCall(tool, call({ tool: 'ue_scene' }), 'tool.before'), false)
})

test('技能条件：开跑时看项目文件、消息里的路径、节点参数和 Bug 模式', () => {
  const facts = { projectFiles: ['Game.uproject', 'README.md'], messagePaths: [], params: {}, bug: false }
  assert.ok(whenMatchesLaunch({ kind: 'project', value: '*.uproject' }, facts))
  assert.equal(whenMatchesLaunch({ kind: 'project', value: '*.sln' }, facts), false)
  const msg = pathsInText('看一下 G:\\Game\\Script\\UI\\Shop.lua 和 `Foo.h`，版本 1.2.3，见 https://x.io/a.md')
  assert.ok(msg.some((p) => p.endsWith('Shop.lua')))
  assert.ok(msg.includes('Foo.h'))
  assert.ok(!msg.includes('1.2.3'))
  assert.ok(whenMatchesLaunch({ kind: 'message', value: '**/*.lua' }, { ...facts, messagePaths: msg }))
  const lang = { kind: 'params' as const, value: 'lang=lua|多种' }
  assert.ok(whenMatchesLaunch(lang, { ...facts, params: { lang: 'lua' } }))
  assert.ok(whenMatchesLaunch(lang, { ...facts, params: { lang: '多种' } }))
  assert.equal(whenMatchesLaunch(lang, { ...facts, params: { lang: 'cpp' } }), false)
  assert.ok(whenMatchesLaunch({ kind: 'phase', value: 'bug' }, { ...facts, bug: true }))
  // 开跑时的条件不在工具调用上判断
  assert.equal(whenMatchesCall(lang, call({ kind: 'edit', paths: ['a.lua'] }), 'tool.before'), false)
})

const edit = (p: string): HookFacts => ({ tool: { kind: 'edit', name: 'Edit', input: {}, path: p, paths: [p] } })
const ctx = (facts: HookFacts, o: Partial<SituationCtx> = {}): SituationCtx => ({
  event: 'tool.before',
  facts,
  task: { plans: [] },
  support: resolveSupport(ModelSupportData.parse({}), 'high'),
  plans: true,
  ...o,
})

test('技能规则：从目录生成情境规则，强模型也推、不占情境规则的条数，关掉的不生成', () => {
  const rules = skillRules(skillCatalog([builtinSkillSource]))
  const ids = rules.map((r) => r.id)
  assert.ok(ids.includes('skill:lua-code-style'))
  assert.ok(ids.includes('skill:systematic-debugging:after'))
  assert.ok(!ids.some((x) => x.startsWith('skill:brainstorming')))
  const c = ctx(edit('G:\\Game\\Script\\a.lua'))
  // limit 0：普通情境规则一条都不推，技能照推（技能推送不按扶持档位、不算条数）
  const hit = pickSituational(c, new Map(), 0, rules)
  assert.deepEqual(
    hit.map((x) => x.skill),
    ['lua-code-style', 'coding-standards'],
  )
  const off = skillCatalog([builtinSkillSource], { 'lua-code-style': { on: false } })
  assert.ok(!skillRules(off).some((r) => r.skill === 'lua-code-style'))
  // 改了条件就按改的来
  const mine = skillCatalog([builtinSkillSource], { 'lua-code-style': { when: [{ kind: 'edit', value: '**/*.txt' }] } })
  const r = skillRules(mine).filter((x) => x.skill === 'lua-code-style')
  assert.equal(pickSituational(c, new Map(), 0, r).length, 0)
  assert.equal(pickSituational(ctx(edit('a/b.txt')), new Map(), 0, r).length, 1)
})

test('技能目录：插件技能默认在调这个插件的工具时推；同名以自带为准；每个对话都带的单独列出', () => {
  const plug = pluginSkillSource([
    { name: 'ue-asset-forge', plugin: 'ue', pluginName: 'UE', guide: '导资产时' },
    { name: 'lua-code-style', plugin: 'x', pluginName: 'X', guide: '冒名' },
  ])
  const cat = skillCatalog([builtinSkillSource, plug])
  const forge = cat.find((x) => x.name === 'ue-asset-forge')!
  assert.deepEqual(forge.when, [{ kind: 'tool', value: 'ue_*' }])
  assert.equal(cat.find((x) => x.name === 'lua-code-style')!.source, 'builtin')
  assert.deepEqual(alwaysSkills({ skills: { b: { always: true }, a: { always: true }, c: { on: false } } }), ['a', 'b'])
})

test('用户改动：和默认一样的不记，全是默认时整条删掉，reset 全部恢复', () => {
  const defaults = { when: [{ kind: 'edit' as const, value: '**/*.lua' }], on: true }
  assert.deepEqual(patchOverride(undefined, { on: false }, defaults), { on: false })
  assert.equal(patchOverride({ on: false }, { on: true }, defaults), undefined)
  assert.equal(patchOverride(undefined, { when: defaults.when }, defaults), undefined)
  assert.deepEqual(patchOverride({ on: false }, { always: true }, defaults), { on: false, always: true })
  assert.deepEqual(patchOverride({ on: false, always: true }, { on: null }, defaults), { always: true })
  assert.equal(patchOverride({ on: false, always: true }, { reset: true }, defaults), undefined)
})

test('推送文字：开头一句说明是面板按情境给的正文、照它做，子文件只给路径；压缩后补推、超上限只给路径各有说法', () => {
  const p = {
    name: 'lua-code-style',
    why: '要改 **/*.lua 的文件',
    dir: '/d/lua-code-style',
    body: '正文',
    files: ['a.md'],
  }
  const text = skillPushText(p)
  assert.match(
    text.split('\n')[0],
    /^【面板】技能「lua-code-style」的正文：面板看到你要改 \*\*\/\*\.lua 的文件，把它直接交给你，照它做/,
  )
  assert.match(text, /子文件在 `\/d\/lua-code-style` 下（a\.md）/)
  assert.match(text, /<skill name="lua-code-style">\n正文\n<\/skill>/)
  assert.match(skillPushText(p, true), /上下文压缩过/)
  assert.match(skillPathText(p), /先读 `\/d\/lua-code-style\/SKILL\.md`/)
})

test('瘦身过的技能入口不超过 8000 字，细节在子文件里', () => {
  for (const rel of ['coding/systematic-debugging', 'docs/project-documentation']) {
    const md = readFileSync(path.join(root, 'skills', rel, 'SKILL.md'), 'utf8')
    assert.ok(md.length < 8000, `${rel} 入口 ${md.length} 字`)
    const subs = readdirSync(path.join(root, 'skills', rel), { recursive: true }).map(String)
    assert.ok(
      subs.some((f) => f !== 'SKILL.md' && f.endsWith('.md')),
      `${rel} 要有子文件`,
    )
  }
})
