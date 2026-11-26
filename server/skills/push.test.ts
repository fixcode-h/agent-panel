/**
 * 技能由面板推送（ADR 0083）：情境对上时推 SKILL.md 正文，同一技能一个对话只推一次，压缩后再推一次，
 * 超了单个对话的上限只推路径；推送记录（push-ledger）的接口给「调用记录」页用，签名不能变
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const home = mkdtempSync(path.join(tmpdir(), 'skill-push-'))
process.env.AGENT_PANEL_DATA = path.join(home, 'data')
process.env.HOME = home
process.env.USERPROFILE = home

const { situationalPush } = await import('../hooks/situational.ts')
const { catalogFor } = await import('./push.ts')
const { recordSkillPush, skillPushes } = await import('./push-ledger.ts')

const catalog = catalogFor({ skills: {} }, [])
const edit = (p: string) => ({ tool: { kind: 'edit' as const, name: 'Edit', input: {}, path: p, paths: [p] } })
const run = (id: string, budget = 20000) => {
  const notes: string[] = []
  const pushed: string[] = []
  const s = situationalPush({
    task: { id, plans: [] } as never,
    plans: true,
    limit: 0,
    rules: false,
    skills: { budget, catalog, onPushed: (n) => pushed.push(n) },
    note: (_h, _e, d) => notes.push(d),
  })!
  return { s, notes, pushed }
}

test('技能推送：改 Lua 文件前推 lua-code-style 正文，同一技能一个对话只推一次，压缩后再推一次', async () => {
  const { s, pushed } = run('t1')
  assert.ok(s.before.includes('edit'))
  const first = await s.push('tool.before', edit('G:\\Game\\Content\\Script\\UI\\Shop.lua'))
  assert.match(first, /^【面板】技能「lua-code-style」的正文：面板看到你要改 \*\*\/\*\.lua 的文件/)
  assert.match(first, /<skill name="lua-code-style">/)
  assert.ok(!first.includes('name: lua-code-style'), 'frontmatter 去掉')
  assert.ok(pushed.includes('lua-code-style'))
  // 再改一个 Lua 文件：不再推
  const again = await s.push('tool.before', edit('Script/b.lua'))
  assert.ok(!again.includes('lua-code-style'))
  // 推送记录：条件写进 trigger
  const rec = skillPushes('t1').find((p) => p.skill === 'lua-code-style')!
  assert.equal(rec.trigger, 'edit **/*.lua')
  assert.ok(rec.tokens > 0 && rec.chars > 0)

  // 上下文压缩后：推过的再推一次，开头写明是补推
  const back = await s.restored()
  assert.match(back, /上下文压缩过，技能「lua-code-style」的正文再给你一次/)
  assert.ok(skillPushes('t1').some((p) => p.skill === 'lua-code-style' && p.trigger === 'restored'))
  // 补推之后照旧只推一次
  assert.equal(await s.push('tool.before', edit('Script/c.lua')), '')
})

test('技能推送：超过单个对话的上限只推一行路径，补推时也只给路径', async () => {
  const { s } = run('t2', 10)
  const text = await s.push('tool.before', edit('Script/a.lua'))
  assert.match(text, /这个对话推送的技能正文已经到上限，先读 `.*lua-code-style\/SKILL\.md`/)
  assert.ok(!text.includes('<skill'))
  assert.ok(skillPushes('t2').every((p) => p.trigger.startsWith('path')))
  assert.match(await s.restored(), /先读 `.*SKILL\.md`/)
})

test('推送记录：recordSkillPush / skillPushes 按对话记，返回副本', () => {
  const p = { skill: 'x', chars: 3, tokens: 1, at: '2026-11-26T00:00:00.000Z', trigger: 'slash' }
  recordSkillPush('t3', p)
  const list = skillPushes('t3')
  assert.deepEqual(list, [p])
  list.pop()
  assert.equal(skillPushes('t3').length, 1)
  assert.deepEqual(skillPushes('没有的'), [])
})

test('开跑时推：参数 lang=lua、项目里有 .uproject（先带它扩展的通用技能）；用户「/名字」点名的记一笔，之后不再推', async () => {
  const { launchSkillPush } = await import('./launch-push.ts')
  const cwd = path.join(home, 'ue-game')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(path.join(cwd, 'Game.uproject'), '{}')
  const pushed: string[] = []
  const text = await launchSkillPush({
    ctx: {
      task: { id: 't4', messages: [], plans: [] } as never,
      project: { id: 'p4', capabilities: {} } as never,
      prompt: '/project-vcs 把改动提交了',
    },
    cwd,
    params: { lang: 'lua' },
    onPushed: (n) => pushed.push(n),
  })
  assert.match(text, /技能「lua-code-style」的正文：面板看到你参数 lang=lua/)
  assert.ok(text.indexOf('技能「project-structure」') < text.indexOf('技能「ue-project-structure」'))
  assert.ok(!text.includes('技能「project-vcs」'), '点名的由「/」展开带正文，这里不重复推')
  const recs = skillPushes('t4')
  assert.equal(recs.find((p) => p.skill === 'project-vcs')?.trigger, 'slash')
  assert.equal(recs.find((p) => p.skill === 'project-structure')?.trigger, 'base:ue-project-structure')
  assert.deepEqual(pushed.sort(), ['lua-code-style', 'project-structure', 'project-vcs', 'ue-project-structure'])
})
