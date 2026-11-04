import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setLang } from './i18n.ts'
import { AgentInput, type Agent } from './schema.ts'
import {
  agentOnlyError,
  chatRoleFor,
  emptyRole,
  normalizeScope,
  scopeError,
  scopeOf,
  settledTodos,
  turnRole,
} from './conv-mode.ts'

setLang('zh')
const mk = (id: string, extra: Partial<AgentInput> = {}): Agent => ({
  ...AgentInput.parse({ name: id, ...extra }),
  id,
  createdAt: '',
  updatedAt: '',
})
const helper = mk('助手', {
  origin: 'builtin:chat',
  scope: 'chat',
  instructions: '你是助手',
  includes: ['rules-c'],
  cli: 'codex',
  model: '@high',
})
const chatRules = mk('聊天约束', { scope: 'chat' })
const worker = mk('执行', { origin: 'builtin:worker' })
const chat = { mode: 'chat' as const, projectId: '', parentTaskId: '', agentId: '' }

test('Chat 页没选角色的对话按内置「助手」跑：取设定和引入，运行配置和 id 留空；项目里和子对话不受影响', () => {
  const role = chatRoleFor(chat, [worker, helper])
  // 旧对话（agentId 为空）不迁移，运行时按助手跑；CLI、模型仍按对话自己选的（canPickRun 照旧）
  assert.deepEqual(
    [role?.id, role?.instructions, role?.includes, role?.cli, role?.model, role?.scope],
    ['', '你是助手', ['rules-c'], '', '', 'chat'],
  )
  assert.equal(chatRoleFor({ ...chat, projectId: 'p' }, [helper]), undefined, '项目里的「无角色」对话不变')
  assert.equal(chatRoleFor({ ...chat, parentTaskId: 'P' }, [helper]), undefined)
  assert.equal(chatRoleFor({ ...chat, agentId: 'x' }, [helper]), undefined, '选了角色的不换')
  // 本机没有助手（演示数据、同步失败）：退回无角色，不崩
  assert.equal(chatRoleFor(chat, [worker]), undefined)
  assert.equal(emptyRole(chat, [worker]).instructions, '')
  assert.equal(emptyRole(chat, [helper]).instructions, '你是助手')
  // Chat 页选的自建 Chat 角色被删了：回退到助手接着聊；项目里的照旧找不到（由 runner 报错）
  assert.equal(turnRole({ ...chat, agentId: 'gone' }, [helper], 'gone')?.instructions, '你是助手')
  assert.equal(turnRole({ ...chat, projectId: 'p', agentId: 'gone' }, [helper], 'gone'), undefined)
  // CLI 自带待办：全部做完的在下一条消息时收起，没做完的留着
  const done = { text: 'a', status: 'done' as const }
  assert.deepEqual(settledTodos([done, done]), [])
  assert.deepEqual(settledTodos([done, { text: 'b', status: 'running' as const }]).length, 2)
})

test('角色分两类：各入口的类别校验、Chat 角色保存时归零能力字段、旧数据按 Agent 角色算', () => {
  assert.equal(scopeOf(mk('旧角色')), 'agent', '旧数据没有 scope 按 Agent 角色读')
  // Chat 页 + Agent 角色、项目 + Chat 角色、子对话 + Chat 角色都拦；面板开的「分析」在 Chat 页放行
  assert.match(scopeError(chat, worker), /是 Agent 角色，只能在项目里用/)
  assert.match(scopeError({ ...chat, projectId: 'p' }, helper), /是 Chat 角色，只能在 Chat 页用/)
  assert.match(scopeError({ ...chat, projectId: 'p', parentTaskId: 'P' }, helper), /Chat 角色/)
  assert.equal(scopeError({ ...chat, analysis: 'diagnose' }, mk('分析', { origin: 'builtin:analyzer' })), '')
  assert.equal(scopeError(chat, helper), '')
  assert.equal(scopeError({ ...chat, projectId: 'p' }, worker), '')
  assert.equal(scopeError({ ...chat, mode: 'workflow', projectId: 'p' }, helper), '', '工作流任务不看对话角色')
  // Chat 角色带了分派、通用、挂载（导入、手改 JSON）：保存时归零，引入只留 Chat 角色
  const input = AgentInput.parse({
    name: '我的聊天',
    scope: 'chat',
    common: true,
    canDelegate: true,
    canPlan: true,
    inlineEdit: 'tiny',
    runIn: 'parent',
    mounts: [{ agentId: worker.id, mode: 'auto' }],
    includes: [chatRules.id, worker.id],
  })
  assert.equal(normalizeScope(input, [worker, chatRules]), '')
  const { common, canDelegate, canPlan, inlineEdit, runIn, mounts, includes } = input
  assert.deepEqual(
    { common, canDelegate, canPlan, inlineEdit, runIn, mounts, includes },
    {
      common: false,
      canDelegate: false,
      canPlan: false,
      inlineEdit: 'off',
      runIn: 'any',
      mounts: [],
      includes: [chatRules.id],
    },
  )
  // Agent 角色不能挂 Chat 角色，引入的 Chat 角色去掉；项目默认角色、工作流里只能用 Agent 角色
  const a = AgentInput.parse({ name: '协调器副本', mounts: [{ agentId: helper.id }], includes: [helper.id] })
  assert.match(normalizeScope(a, [helper]), /不能挂载/)
  assert.deepEqual(a.includes, [])
  assert.match(agentOnlyError(['', helper.id], [worker, helper]), /是 Chat 角色/)
  assert.equal(agentOnlyError(['', worker.id], [worker, helper]), '')
})

test('Chat 页能选的角色：自建的 Chat 角色；默认的「助手」和只供引入的「聊天约束」不列', async () => {
  const { pickableChatRole } = await import('./conv-mode.ts')
  const role = (over: Partial<{ enabled: boolean; origin: string; scope: 'chat' | 'agent' }>) => ({
    enabled: true,
    origin: '',
    scope: 'chat' as const,
    ...over,
  })
  assert.ok(pickableChatRole(role({})))
  assert.ok(!pickableChatRole(role({ origin: 'builtin:chat' })), '助手是「无」那一项')
  assert.ok(!pickableChatRole(role({ origin: 'builtin:chat-rules' })), '聊天约束只供引入')
  assert.ok(!pickableChatRole(role({ scope: 'agent' })), 'Agent 角色不在 Chat 页选')
  assert.ok(!pickableChatRole(role({ enabled: false })))
})
