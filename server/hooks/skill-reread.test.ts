import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { isSkillFile, skillRereadGuard } from './skill-reread.ts'

const read = (p: string, ranged = false) => ({
  tool: { kind: 'read' as const, name: 'Read', input: {}, path: p, paths: [p], ranged },
})

test('同一会话里整份重读技能：按内容认（两处副本也算），拦一次；再读、分段读、压缩后都放行', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'reread-'))
  for (const d of ['skills/openspec', '.claude/skills/workflow/openspec']) {
    mkdirSync(path.join(dir, d), { recursive: true })
    writeFileSync(path.join(dir, d, 'SKILL.md'), '# OpenSpec\n规则')
  }
  const g = skillRereadGuard()
  assert.equal(g.before(dir, read('skills/openspec/SKILL.md')), '')
  const why = g.before(dir, read('.claude/skills/workflow/openspec/SKILL.md'))
  assert.match(why, /另一处副本/)
  assert.equal(g.before(dir, read('.claude/skills/workflow/openspec/SKILL.md')), '', '被拦后坚持再读就放行')
  assert.equal(g.before(dir, read('skills/openspec/SKILL.md', true)), '', '分段读不拦')
  g.restored()
  assert.equal(g.before(dir, read('skills/openspec/SKILL.md')), '', '压缩后重新记')
  // 改过内容就是新的一份
  writeFileSync(path.join(dir, 'skills/openspec/SKILL.md'), '# OpenSpec\n规则改了')
  assert.equal(g.before(dir, read('skills/openspec/SKILL.md')), '')
})

test('只管技能文件：普通源码、skills 目录外的 Markdown 不拦', () => {
  assert.equal(isSkillFile('src/app.ts'), false)
  assert.equal(isSkillFile('docs/design.md'), false)
  assert.equal(isSkillFile('skills/workflow/openspec/stage-3.md'), true)
  assert.equal(isSkillFile('C:\\x\\skills\\a\\SKILL.md'), true)
})
