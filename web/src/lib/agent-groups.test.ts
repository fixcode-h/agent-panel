/**
 * 角色页「按标签」视图的分组规则：没有标签的角色全进「默认」，组有稳定的排序，零组不出现。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Agent, Tag } from '@shared/schema'
import { listableAgents } from '@shared/builtin/core'
import { DEFAULT_AGENT_GROUP, groupAgentsByTag } from '@/lib/agent-groups'

const tag = (id: string, name: string, color: Tag['color'] = 'gray') =>
  ({ id, name, color, description: '', createdAt: '', updatedAt: '' }) as Tag

const agent = (id: string, tags: string[]) => ({ id, name: id, origin: '', tags }) as Agent

const TAGS = [tag('t1', 'alpha'), tag('t2', 'beta'), tag('t3', 'gamma')]

test('没有标签的角色全部归到「默认」，排在有标签的组后面', () => {
  const groups = groupAgentsByTag([agent('a', []), agent('b', ['t1']), agent('c', [])], TAGS)
  assert.deepEqual(
    groups.map((g) => [g.id, g.agents.map((x) => x.id)]),
    [
      ['t1', ['b']],
      [DEFAULT_AGENT_GROUP, ['a', 'c']],
    ],
  )
  assert.equal(groups[1].label, '默认')
  // 「默认」组没有标签实体，渲染时不带颜色
  assert.equal(groups[1].tag, undefined)
})

test('带多个标签的角色在每个标签组里都出现一次', () => {
  const groups = groupAgentsByTag([agent('a', ['t1', 't2'])], TAGS)
  assert.deepEqual(
    groups.map((g) => g.id),
    ['t1', 't2'],
  )
  assert.ok(groups.every((g) => g.agents.length === 1))
})

test('组按角色数降序，同数按名称；「默认」不管多少都排最后', () => {
  const groups = groupAgentsByTag(
    [agent('a', ['t3']), agent('b', ['t1']), agent('c', ['t1']), agent('d', ['t2']), agent('e', [])],
    TAGS,
  )
  // alpha 有两个角色排第一，beta / gamma 各一个按名称排，默认组最后
  assert.deepEqual(
    groups.map((g) => g.id),
    ['t1', 't2', 't3', DEFAULT_AGENT_GROUP],
  )
})

test('零组不返回，同一个角色的重复标签只算一次', () => {
  const groups = groupAgentsByTag([agent('a', ['t1', 't1']), agent('b', [])], TAGS)
  assert.deepEqual(
    groups.map((g) => [g.id, g.agents.length]),
    [
      ['t1', 1],
      [DEFAULT_AGENT_GROUP, 1],
    ],
  )
})

test('标签被删了（找不到实体）的角色归「默认」，不会从列表里消失', () => {
  const groups = groupAgentsByTag([agent('a', ['gone']), agent('b', ['t1', 'gone'])], TAGS)
  assert.deepEqual(
    groups.map((g) => [g.id, g.agents.map((x) => x.id)]),
    [
      ['t1', ['b']],
      [DEFAULT_AGENT_GROUP, ['a']],
    ],
  )
})

test('用户自建叫「默认」的标签：和内置的「默认」组靠 id 区分，界面靠带说明的标题区分', () => {
  const clash = tag('t9', '默认')
  const groups = groupAgentsByTag([agent('a', ['t9']), agent('b', [])], [...TAGS, clash])
  assert.deepEqual(
    groups.map((g) => [g.id, g.label]),
    [
      ['t9', '默认'],
      [DEFAULT_AGENT_GROUP, '默认'],
    ],
  )
  // 两组名字相同（都是「默认」），靠 id 不冲突；页面把内置组的标题写成那句带说明的文案，用户不会认错
  assert.notEqual(groups[0].id, groups[1].id)
  assert.equal(groups[1].id, DEFAULT_AGENT_GROUP)
})

test('角色页分组不含「子任务」（它不作为可选角色展示）', () => {
  // 角色页先过滤可列的角色，再交给 groupAgentsByTag：不能让它单独撑出一个「默认」组
  const agents = [{ ...agent('a', []), origin: 'builtin:helper' }, agent('b', ['t1']), agent('c', [])] as Agent[]
  const groups = groupAgentsByTag(listableAgents(agents), TAGS)
  assert.deepEqual(
    groups.map((g) => [g.id, g.agents.map((x) => x.id)]),
    [
      ['t1', ['b']],
      [DEFAULT_AGENT_GROUP, ['c']],
    ],
  )
})

test('已经有角色但一个标签都没有时只剩「默认」组，不会出现空组', () => {
  const groups = groupAgentsByTag([agent('a', []), agent('b', [])], TAGS)
  assert.deepEqual(
    groups.map((g) => [g.label, g.agents.length]),
    [['默认', 2]],
  )
  assert.deepEqual(groupAgentsByTag([], TAGS), [])
})
