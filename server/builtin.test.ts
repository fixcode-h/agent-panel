import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AgentInput, WorkflowInput, type Agent } from '../shared/schema.ts'
import { composeRole, nodeMissingParams, resolveParams } from '../shared/agent-role.ts'
import { findRefCycle, topoOrder } from '../shared/flow.ts'
import { frontField } from '../shared/library.ts'
import { BUILTIN_AGENTS, COMMON_AGENT_KEYS } from '../shared/builtin/agents.ts'
import { BUILTIN_WORKFLOWS, buildWorkflow, builtinAgentKeys } from '../shared/builtin/workflows.ts'
import { seedBuiltins, type BuiltinOps } from '../shared/builtin/install.ts'
import { CategoryInput, TagInput } from '../shared/schema.ts'
import { ensureBundled, installBundled, listBundled } from './bundled-skills.ts'

const root = path.resolve(import.meta.dirname, '..', 'skills')
const skillDirs = readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((c) =>
    readdirSync(path.join(root, c.name), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ category: c.name, name: d.name })),
  )

// 内置 Agent 当成本机已经建好的 Agent（id 就用 key）
const agents: Agent[] = BUILTIN_AGENTS.map((b) => ({
  ...AgentInput.parse({ ...b.agent, includes: b.includes }),
  id: b.key,
  createdAt: '',
  updatedAt: '',
}))

test('自带 Skill：名字和文件夹一致、不重名、写了说明', () => {
  assert.ok(skillDirs.length >= 15)
  const names = skillDirs.map((s) => s.name)
  assert.equal(new Set(names).size, names.length, '不同分类里有同名的 Skill')
  for (const s of skillDirs) {
    const text = readFileSync(path.join(root, s.category, s.name, 'SKILL.md'), 'utf8')
    assert.equal(frontField(text, 'name'), s.name, `${s.name} 的 name 和文件夹名不一致`)
    const desc = frontField(text, 'description')
    assert.ok(desc.length > 10 && desc.length <= 1024, `${s.name} 的 description 不合适`)
    assert.ok(!text.startsWith('﻿'), `${s.name} 带了 BOM`)
  }
})

test('内置 Agent：引用的 Skill 都是自带的，引入的 Agent 存在，角色设定能拼出来', () => {
  const names = new Set(skillDirs.map((s) => s.name))
  const keys = new Set(BUILTIN_AGENTS.map((b) => b.key))
  assert.equal(keys.size, BUILTIN_AGENTS.length, 'key 重复')
  for (const b of BUILTIN_AGENTS) {
    for (const s of b.agent.skills) assert.ok(names.has(s), `${b.agent.name} 引用的 Skill「${s}」不存在`)
    for (const k of b.includes) assert.ok(keys.has(k), `${b.agent.name} 引入的「${k}」不存在`)
    const a = agents.find((x) => x.id === b.key)!
    const role = composeRole(a, agents)
    // 默认参数下模板都能展开，不留下没处理的写法
    assert.doesNotMatch(role, /\{\{/, `${b.agent.name} 的角色设定里有没展开的模板`)
    for (const p of b.agent.params)
      if (p.type === 'select')
        assert.ok(p.options.includes(String(p.default)), `${b.agent.name} 的参数 ${p.key} 默认值不在选项里`)
  }
  // 除了「通用约束」自己，都引入了它
  for (const a of agents.filter((x) => x.id !== 'rules')) assert.ok(a.includes.includes('rules'), a.name)
})

test('内置工作流：结构合法，节点的 Agent、验收流程和参数都对得上', () => {
  for (const w of BUILTIN_WORKFLOWS) {
    const keys = builtinAgentKeys(w)
    for (const k of keys)
      assert.ok(
        agents.some((a) => a.id === k),
        `${w.name} 用到的 Agent「${k}」不存在`,
      )
    const built = WorkflowInput.parse(buildWorkflow(w, (k) => k))
    const wf = { ...built, id: w.key, createdAt: '', updatedAt: '' }
    assert.equal(findRefCycle(wf, [wf]), null, `${w.name} 的流程互相引用`)
    for (const f of built.flows) {
      assert.equal(topoOrder(f).length, f.nodes.length, `${w.name}/${f.name} 有环或连不上的节点`)
      const ids = new Set(f.nodes.map((n) => n.id))
      for (const e of f.edges) {
        assert.ok(ids.has(e.from) || e.from === 'start', `${w.name}/${f.name} 连线起点 ${e.from} 不存在`)
        assert.ok(ids.has(e.to) || e.to === 'end', `${w.name}/${f.name} 连线终点 ${e.to} 不存在`)
      }
      for (const n of f.nodes) {
        if (n.hooks.review)
          assert.ok(
            built.flows.some((x) => x.id === n.hooks.review!.id),
            `${n.title} 的验收流程不存在`,
          )
        const a = agents.find((x) => x.id === n.agentId)!
        // 节点上写的参数都是这个 Agent 的，值也合法
        for (const [k, v] of Object.entries(n.params)) {
          const p = a.params.find((x) => x.key === k)
          assert.ok(p, `${w.name}/${n.title} 的参数 ${k} 不是「${a.name}」的`)
          assert.deepEqual(resolveParams([p], { [k]: v }).values[k], v, `${w.name}/${n.title} 的参数 ${k} 值不合法`)
        }
        assert.deepEqual(nodeMissingParams(a, n.params), [], `${w.name}/${n.title} 有没填的参数`)
      }
    }
  }
})

test('自带 Skill：装进 CLI 的用户目录，已有的不覆盖，执行前自动补齐缺的', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'bundled-'))
  const old = process.env.HOME
  process.env.HOME = home
  try {
    const list = await listBundled()
    assert.equal(list.length, skillDirs.length)
    assert.ok(list.every((s) => s.status.claude === 'missing'))
    const one = list.find((s) => s.name === 'blender')!
    assert.ok(one.files > 5, '带上了脚本和参考资料')

    const r = await installBundled(['blender'], ['claude'], false)
    assert.deepEqual(r.done, ['claude/blender'])
    const dir = path.join(home, '.claude/skills/blender')
    assert.ok(existsSync(path.join(dir, 'SKILL.md')))
    assert.ok(existsSync(path.join(dir, 'scripts/inspect_scene.py')))
    assert.equal((await listBundled()).find((s) => s.name === 'blender')!.status.claude, 'same')

    // 用户改过的：不覆盖，状态是「不同」；明确覆盖时换回自带的
    writeFileSync(path.join(dir, 'SKILL.md'), '改过')
    assert.equal((await listBundled()).find((s) => s.name === 'blender')!.status.claude, 'changed')
    assert.deepEqual((await installBundled(['blender'], ['claude'], false)).skipped, ['claude/blender'])
    assert.equal(readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), '改过')
    await installBundled(['blender'], ['claude'], true)
    assert.notEqual(readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), '改过')

    // 执行前补齐：只装缺的、只装自带的，用户的同名 Skill 不动
    writeFileSync(path.join(dir, 'SKILL.md'), '用户的')
    const added = await ensureBundled('claude', ['blender', 'grilling', '不存在的'])
    assert.deepEqual(added, ['grilling'])
    assert.equal(readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), '用户的')
  } finally {
    process.env.HOME = old
    rmSync(home, { recursive: true, force: true })
  }
})

test('首次启动装上全部内置工作流：Agent 只建一份并互相引用好，分类、标签按名字复用', async () => {
  let n = 0
  const meta = () => ({ id: `id${++n}`, createdAt: '', updatedAt: '' })
  const ops: BuiltinOps = {
    createAgent: async (a) => ({ ...AgentInput.parse(a), ...meta() }),
    createCategory: async (name, scope) => ({ ...CategoryInput.parse({ name, scope }), ...meta() }),
    createTag: async (x) => ({ ...TagInput.parse(x), ...meta() }),
    createWorkflow: async (w) => ({ ...WorkflowInput.parse(w), ...meta() }),
  }
  const mine = { ...AgentInput.parse({ name: '开发者' }), ...meta() }
  const r = await seedBuiltins({ agents: [mine], categories: [], tags: [], workflows: [] }, ops)
  assert.equal(r.workflows.length, BUILTIN_WORKFLOWS.length)
  const built = r.agents.filter((a) => a.origin.startsWith('builtin:'))
  assert.equal(built.length, BUILTIN_AGENTS.length, '每个内置 Agent 只建一份')
  // 和用户自己的 Agent 重名时加后缀，两个都在
  assert.ok(r.agents.some((a) => a.name === '开发者（内置）' && a.origin === 'builtin:developer'))
  const rules = built.find((a) => a.origin === 'builtin:rules')!
  for (const a of built.filter((x) => x !== rules)) assert.deepEqual(a.includes, [rules.id], a.name)
  // 工作流节点都指向建好的 Agent
  const ids = new Set(r.agents.map((a) => a.id))
  for (const w of r.workflows)
    for (const f of w.flows) for (const nd of f.nodes) assert.ok(ids.has(nd.agentId), nd.title)
  assert.equal(r.tags.filter((x) => x.name === '内置').length, 1)
  assert.equal(new Set(r.categories.map((c) => `${c.scope}/${c.name}`)).size, r.categories.length, '分类没有重复')
  // 通用 Agent 跟着工作流一起建，标成通用
  assert.ok(COMMON_AGENT_KEYS.length >= 3)
  for (const k of COMMON_AGENT_KEYS) assert.ok(built.find((a) => a.origin === `builtin:${k}`)?.common, k)
  assert.equal(built.filter((a) => a.common).length, COMMON_AGENT_KEYS.length)
  // 再跑一遍：已有的跳过，不重复建
  const again = await seedBuiltins(r, ops)
  assert.equal(again.workflows.length, r.workflows.length)
  assert.equal(again.agents.length, r.agents.length)
})
