/**
 * 一段回复收尾后折叠起来的过程：统计口径（折叠行上的「查看 1 个文件 · 思考 1 次」）和
 * 一段结束后又从子对话、后台命令来了新内容时的分段。
 * 界面（Messages.tsx 的 FoldedRun / ChatReply）直接用这里的结果，这里测出来的就是界面上的口径。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TaskMessage, ToolUse } from '@shared/schema'
import { setLang, t } from '@shared/i18n'
import {
  addFoldCut,
  foldCuts,
  foldStats,
  keptOut,
  markFold,
  replyText,
  segOpenOf,
  splitFolds,
  toggleSegOpen,
} from './fold.ts'

// 断言里是中文，不管本机是什么语言
setLang('zh')

const at = '2025-01-01T00:00:00.000Z'
const tool = (kind: ToolUse['kind'], label: string, extra: Partial<ToolUse> = {}): ToolUse => ({
  kind,
  label,
  detail: '',
  ...extra,
})
const agent = (id: string, text: string, extra: Partial<TaskMessage> = {}): TaskMessage => ({
  id,
  role: 'agent',
  agentId: 'a1',
  step: '',
  text,
  tools: [],
  at,
  ...extra,
})
const panel = (id: string, kind: NonNullable<TaskMessage['panel']>, text: string): TaskMessage => ({
  ...agent(id, text),
  role: 'system',
  panel: kind,
})

test('foldStats：折叠行只统计这一段里的操作，改的文件不多时直接写文件名', () => {
  const msgs = [
    agent('m1', '', { thinking: '先看看', tools: [tool('read', 'README.md'), tool('read', 'README.md')] }),
    agent('m2', '第一段回复'),
  ]
  const stats = foldStats(msgs)
  assert.equal(stats.last, 1)
  // 同一个文件读两次只算一个
  assert.deepEqual(stats.parts, [t('查看 {n} 个文件', { n: 1 }), t('思考 {n} 次', { n: 1 })])
  assert.equal(stats.failed, 0)

  // 改的文件不超过两个时写文件名，一眼看出这段动了哪里
  const edit = foldStats([
    agent('e1', '', { tools: [tool('edit', 'web/src/a.ts'), tool('edit', 'web/src/b.ts')] }),
    agent('e2', '改好了'),
  ])
  assert.deepEqual(edit.parts, [t('修改 {files}', { files: 'a.ts、b.ts' })])
})

test('foldStats：报错和子对话的提问不进统计，也不收进折叠', () => {
  const err: TaskMessage = { ...panel('x1', 'note', '出错了'), panel: undefined, error: true }
  const ask = panel('x2', 'ask', '请选择')
  assert.equal(keptOut(err), true)
  assert.equal(keptOut(ask), true)
  assert.equal(keptOut(panel('x3', 'background', '后台命令跑完了')), false)

  const stats = foldStats([err, ask, agent('m1', '回复')])
  assert.deepEqual(stats.parts, [])
})

test('splitFolds：一段收尾后来了两条面板结果，再收尾时按发生顺序分成两段', () => {
  // 第一段：读文件 + 思考，然后一条回复
  const first = [
    agent('m1', '', { thinking: '先看这个文件', tools: [tool('read', 'README.md')] }),
    agent('m2', '第一段回复'),
  ]
  // 这一段收尾：记下折到第 2 条
  let cuts = markFold([], first.length)
  assert.deepEqual(cuts, [2])

  // 收尾后又来两条面板结果（后台命令、子任务交回），CLI 被拉起来接着做，然后再次收尾
  const rest = [
    panel('m3', 'background', '【面板】后台命令 `npm run test` 跑完了：成功'),
    panel('m4', 'helpers', '### 子任务\n结果'),
    agent('m5', '', { thinking: '接着跑测试', tools: [tool('run', 'npm run test')] }),
    agent('m6', '第二段回复'),
  ]
  const msgs = [...first, ...rest]
  cuts = markFold(cuts, msgs.length)
  assert.deepEqual(cuts, [2, 6])
  // 收尾时没有新内容就不再记一段，避免出现空段
  assert.deepEqual(markFold(cuts, msgs.length), [2, 6])

  const parts = splitFolds(msgs, cuts)
  // 最后一段（这次收尾之后新来的内容）是空的：收尾后没有新内容时不显示空段
  assert.equal(parts.length, 3)
  assert.deepEqual(
    parts.map((part) => part.map((m) => m.id)),
    [['m1', 'm2'], ['m3', 'm4', 'm5', 'm6'], []],
  )

  // 历史段原样保留：顺序、内容都不变，展开后看到的就是当时那段
  assert.deepEqual(parts[0], first)

  // 各段只统计自己那段：历史段没有面板结果，新段没有读文件
  const oldStats = foldStats(parts[0])
  assert.equal(oldStats.last, 1)
  assert.deepEqual(oldStats.parts, [t('查看 {n} 个文件', { n: 1 }), t('思考 {n} 次', { n: 1 })])

  const newStats = foldStats(parts[1])
  assert.equal(newStats.last, 3)
  assert.deepEqual(newStats.parts, [
    t('运行 {n} 条命令', { n: 1 }),
    t('思考 {n} 次', { n: 1 }),
    t('{n} 条面板结果', { n: 2 }),
  ])
})

test('splitFolds：没记过分段（这一轮第一次收尾）时还是整段，切点超出消息数时按现有消息切', () => {
  const msgs = [agent('m1', '', { thinking: '想' }), agent('m2', '回复')]
  const parts = splitFolds(msgs, [])
  assert.equal(parts.length, 1)
  assert.deepEqual(parts[0], msgs)
  // 记下的切点不会超过现在的消息数；万一超出也不丢消息（后面的段为空）
  assert.deepEqual(
    splitFolds(msgs, [99]).map((p) => p.map((m) => m.id)),
    [['m1', 'm2'], []],
  )
})

test('addFoldCut：同一轮收尾几次记几段，切走再回来还认得出', () => {
  assert.deepEqual(foldCuts('turn-a'), [])
  assert.deepEqual(addFoldCut('turn-a', 2), [2])
  // 收尾后没有新内容：不重复记同一位置
  assert.deepEqual(addFoldCut('turn-a', 2), [2])
  assert.deepEqual(addFoldCut('turn-a', 5), [2, 5])
  assert.deepEqual(foldCuts('turn-a'), [2, 5])
  // 别的轮互不影响
  assert.deepEqual(foldCuts('turn-b'), [])
})

test('addFoldCut：第一次画出来时这一轮已经收尾也记一段，之后接着输出时前面那段保持折叠', () => {
  // 刷新、切回页签、被下面的计划卡片挤成非最后一段：拿到的这一轮已经不是执行中，同样要记收尾位置
  const msgs = [agent('m1', '', { thinking: '想' }), agent('m2', '总结')]
  let cuts = addFoldCut('turn-c', msgs.length)
  assert.deepEqual(cuts, [2])
  // 子对话回报、后台命令结果把它重新拉起来，接着写了几条，再次收尾
  const all = [...msgs, panel('m3', 'background', '【面板】后台命令跑完了：成功'), agent('m4', '接着总结')]
  cuts = addFoldCut('turn-c', all.length)
  // 前面那段没被合并成一段：老内容折在上面，新内容另起一段
  assert.deepEqual(
    splitFolds(all, cuts).map((p) => p.map((m) => m.id)),
    [['m1', 'm2'], ['m3', 'm4'], []],
  )
  const old = splitFolds(all, cuts)[0]
  assert.deepEqual(foldStats(old).parts, [t('思考 {n} 次', { n: 1 })])
})

test('segOpenOf / toggleSegOpen：点开、收起的选择按「这一轮 + 第几段」记下，重新挂载时拿得到', () => {
  assert.equal(segOpenOf('turn-x#0'), false)
  assert.equal(toggleSegOpen('turn-x#0'), true)
  assert.equal(segOpenOf('turn-x#0'), true)
  // 别的段、别的轮不受影响
  assert.equal(segOpenOf('turn-x#1'), false)
  assert.equal(segOpenOf('turn-y#0'), false)
  // 再点一下收起
  assert.equal(toggleSegOpen('turn-x#0'), false)
  assert.equal(segOpenOf('turn-x#0'), false)
})

test('replyText：模型当成文字说出来的工具调用写法从正文里去掉了', () => {
  const markup = '看看这个\n<invoke name="read"><parameter name="p">a</parameter></invoke>'
  assert.equal(replyText(agent('m1', markup)), '看看这个')
  // 用户消息原样显示
  assert.equal(replyText({ ...agent('u1', markup), role: 'user' }), markup)
})
