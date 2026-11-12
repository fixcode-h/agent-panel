/**
 * 失败后「换个模型重试」：能选哪些模型、对话上改哪些字段、用角色的对话换的模型怎么生效。运行：npm run test:unit
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { retryModelChoices, retryModelPatch, withTaskModel } from './run.ts'

test('能选的模型：去掉正在用的那个，顺序照模型列表；空 id 不列', () => {
  const models = [{ id: 'a' }, { id: 'b' }, { id: '' }, { id: 'c' }]
  assert.deepEqual(
    retryModelChoices(models, 'b').map((m) => m.id),
    ['a', 'c'],
  )
  assert.deepEqual(retryModelChoices([{ id: 'only' }], 'only'), [])
})

test('不用角色的对话：直接改 model；原来的强度新模型支持就留着，不支持（或不知道）时清掉回到默认', () => {
  const chat = { agentId: '', effort: 'high' }
  assert.deepEqual(retryModelPatch(chat, { cli: 'codex', model: 'm2', efforts: ['low', 'high'] }), {
    model: 'm2',
    effort: 'high',
  })
  assert.deepEqual(retryModelPatch(chat, { cli: 'codex', model: 'm2', efforts: ['low'] }), { model: 'm2', effort: '' })
  assert.deepEqual(retryModelPatch(chat, { cli: 'codex', model: 'm2' }), { model: 'm2', effort: 'high' })
  assert.deepEqual(retryModelPatch({ agentId: '', effort: '' }, { cli: 'codex', model: 'm2', efforts: [] }), {
    model: 'm2',
    effort: '',
  })
})

test('用角色的对话：记成 modelOverride，只对这个对话生效；CLI 对不上（角色后来换了 CLI）就不用', () => {
  const patch = retryModelPatch({ agentId: 'r', effort: '' }, { cli: 'claude', model: 'sonnet' })
  assert.deepEqual(patch, { modelOverride: { cli: 'claude', model: 'sonnet' } })
  const role = { id: 'r', cli: 'claude', model: 'opus', effort: 'high' }
  const chat = { mode: 'chat', agentId: 'r', modelOverride: { cli: 'claude', model: 'sonnet' } }
  assert.deepEqual(withTaskModel(role, chat), { ...role, model: 'sonnet' })
  assert.equal(withTaskModel({ ...role, cli: 'codex' }, chat).model, 'opus', '角色换了 CLI：别家的模型名不传给新 CLI')
  // 跟随默认 CLI 的角色：对话定下的 CLI 和换模型时的一致才用
  const follow = { ...role, cli: '' }
  assert.equal(withTaskModel(follow, { ...chat, sessionCli: 'claude' }).model, 'sonnet')
  assert.equal(withTaskModel(follow, { ...chat, sessionCli: 'codex' }).model, 'opus')
  // 别的对话、工作流不受影响
  assert.equal(withTaskModel(role, { ...chat, agentId: 'other' }), role)
  assert.equal(withTaskModel(role, { ...chat, mode: 'workflow' }), role)
})
