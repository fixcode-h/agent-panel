import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { composeAgentsMd, DeployRun } from '../shared/deploy.ts'
import { deploy, skillUpdates } from './deploy.ts'

test('部署：技能按分类放进 ~/.agents/skills，全局说明附上技能清单写进各 CLI，原文件备份', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'deploy-'))
  const old = { ...process.env }
  // Windows 上 os.homedir() 读 USERPROFILE，两个都设才能真的隔离到临时目录
  process.env.HOME = home
  process.env.USERPROFILE = home
  for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PI_CODING_AGENT_DIR']) delete process.env[k]
  try {
    const piDoc = path.join(home, '.pi/agent/AGENTS.md')
    mkdirSync(path.dirname(piDoc), { recursive: true })
    writeFileSync(piDoc, '用户自己的')
    const run = DeployRun.parse({ agentsMd: '# 规则\n', skills: ['grilling'], clis: ['claude', 'pi'] })
    const r = await deploy(run)
    assert.deepEqual(r.skills, ['grilling'])
    const skill = path.join(home, '.agents/skills/workflow/grilling/SKILL.md')
    assert.ok(existsSync(skill))

    const claude = readFileSync(path.join(home, '.claude/CLAUDE.md'), 'utf8')
    assert.ok(claude.startsWith('# 规则\n\n## 技能'))
    assert.ok(claude.includes('~/.agents/skills/workflow/grilling/SKILL.md'))
    assert.equal(readFileSync(piDoc, 'utf8'), claude)
    assert.equal(readFileSync(`${piDoc}.bak`, 'utf8'), '用户自己的')
    assert.ok(!existsSync(path.join(home, '.codex/AGENTS.md')), '没选的 CLI 不写')

    // 再部署一次什么都不变
    const again = await deploy(run)
    assert.deepEqual(again.skills, [])
    assert.ok(again.docs.every((d) => d.result === 'same'))

    // 改过的技能不覆盖、取消勾选也不删；没改过的取消勾选就移除
    writeFileSync(skill, '改过')
    // 和自带的不同就提示可以更新；没勾选的不提示（部署不会动它，提示点会一直消不掉）
    assert.deepEqual((await skillUpdates(['grilling'])).deployed, ['grilling'])
    assert.deepEqual((await skillUpdates([])).deployed, [])
    const kept = await deploy({ ...run, skills: [] })
    assert.deepEqual(kept.kept, ['grilling'])
    assert.equal(readFileSync(skill, 'utf8'), '改过')
    await deploy({ ...run, overwrite: true })
    assert.notEqual(readFileSync(skill, 'utf8'), '改过')
    const removed = await deploy({ ...run, skills: [] })
    assert.deepEqual(removed.removed, ['grilling'])
    assert.ok(!existsSync(skill))
    assert.ok(!readFileSync(piDoc, 'utf8').includes('## 技能'))
  } finally {
    process.env = old
    rmSync(home, { recursive: true, force: true })
  }
})

test('没有选技能时全局说明原样输出', () => {
  assert.equal(composeAgentsMd('# 规则\n\n', []), '# 规则\n')
  assert.equal(composeAgentsMd('', []), '')
})
