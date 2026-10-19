import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { composeAgentsMd, DeployRun } from '../shared/deploy.ts'
import { deploy } from './deploy.ts'

test('部署：技能按分类放进 ~/.agents/skills，全局说明附上技能清单写进各 CLI，原文件备份', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'deploy-'))
  const old = { ...process.env }
  process.env.HOME = home
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'PI_CODING_AGENT_DIR']) delete process.env[k]
  try {
    const gemini = path.join(home, '.gemini/GEMINI.md')
    mkdirSync(path.dirname(gemini), { recursive: true })
    writeFileSync(gemini, '用户自己的')
    const run = DeployRun.parse({ agentsMd: '# 规则\n', skills: ['grilling'], clis: ['claude', 'gemini'] })
    const r = await deploy(run)
    assert.deepEqual(r.skills, ['grilling'])
    const skill = path.join(home, '.agents/skills/workflow/grilling/SKILL.md')
    assert.ok(existsSync(skill))

    const claude = readFileSync(path.join(home, '.claude/CLAUDE.md'), 'utf8')
    assert.ok(claude.startsWith('# 规则\n\n## 技能'))
    assert.ok(claude.includes('~/.agents/skills/workflow/grilling/SKILL.md'))
    assert.equal(readFileSync(gemini, 'utf8'), claude)
    assert.equal(readFileSync(`${gemini}.bak`, 'utf8'), '用户自己的')
    assert.ok(!existsSync(path.join(home, '.codex/AGENTS.md')), '没选的 CLI 不写')

    // 再部署一次什么都不变
    const again = await deploy(run)
    assert.deepEqual(again.skills, [])
    assert.ok(again.docs.every((d) => d.result === 'same'))

    // 改过的技能不覆盖、取消勾选也不删；没改过的取消勾选就移除
    writeFileSync(skill, '改过')
    const kept = await deploy({ ...run, skills: [] })
    assert.deepEqual(kept.kept, ['grilling'])
    assert.equal(readFileSync(skill, 'utf8'), '改过')
    await deploy({ ...run, overwrite: true })
    assert.notEqual(readFileSync(skill, 'utf8'), '改过')
    const removed = await deploy({ ...run, skills: [] })
    assert.deepEqual(removed.removed, ['grilling'])
    assert.ok(!existsSync(skill))
    assert.ok(!readFileSync(gemini, 'utf8').includes('## 技能'))
  } finally {
    process.env = old
    rmSync(home, { recursive: true, force: true })
  }
})

test('没有选技能时全局说明原样输出', () => {
  assert.equal(composeAgentsMd('# 规则\n\n', []), '# 规则\n')
  assert.equal(composeAgentsMd('', []), '')
})
