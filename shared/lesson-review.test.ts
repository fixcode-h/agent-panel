/**
 * 项目教训的 AI 评审：评审块的解析、逐条应用、已应用的判定；教训的「默认」页签。
 * 运行：npm run test:unit
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProjectLesson } from './schema.ts'
import { DEFAULT_TAB, inTab, lessonTabs, tagCounts } from './lessons.ts'
import {
  LESSON_REVIEW_LANG,
  applyReviewItem,
  lessonReviewPrompt,
  parseLessonReview,
  reviewItemState,
  stripLessonReview,
} from './lesson-review.ts'

const L = (id: string, extra: Partial<ProjectLesson> = {}) =>
  ProjectLesson.parse({ id, title: `规则 ${id}`, rule: `说明 ${id}`, ...extra })

const block = (o: unknown) => `结论。\n\n\`\`\`${LESSON_REVIEW_LANG}\n${JSON.stringify(o)}\n\`\`\``

test('评审块：读最后一个，格式不对和缺新规则的单条跳过，问题只认已知的', () => {
  const text = `${block({ items: [{ id: 'a', action: 'delete' }] })}\n\n${block({
    summary: '两条要改',
    items: [
      { id: 'a', action: 'delete', problems: ['outdated', '乱写'] },
      { id: 'b', action: 'rewrite' },
      { id: 'c', action: 'nope' },
      { id: 'd', action: 'merge', title: '合并后', merge: ['e', 'd'] },
    ],
  })}`
  const r = parseLessonReview(text)!
  assert.equal(r.summary, '两条要改')
  assert.deepEqual(
    r.items.map((x) => [x.id, x.action]),
    [
      ['a', 'delete'],
      ['d', 'merge'],
    ],
  )
  assert.deepEqual(r.items[0].problems, ['outdated'])
  // 合并列表里去掉自己
  assert.deepEqual(r.items[1].merge, ['e'])
  assert.equal(parseLessonReview('没有块'), null)
  assert.equal(stripLessonReview(text).includes(LESSON_REVIEW_LANG), false)
  // 流式写到一半：去掉到结尾
  assert.equal(stripLessonReview(`前面\n\`\`\`${LESSON_REVIEW_LANG}\n{"items": [`), '前面\n')
})

test('应用建议：删除、停用、改写留记录、合并删掉其余几条；已应用按当前教训现算', () => {
  const ls = [L('a'), L('b', { tags: ['测试'] }), L('c'), L('d')]
  const del = { id: 'a', action: 'delete' as const, problems: [], why: '', title: '', rule: '', merge: [] }
  assert.equal(reviewItemState(ls, del), 'pending')
  const afterDel = applyReviewItem(ls, del)
  assert.deepEqual(
    afterDel.map((l) => l.id),
    ['b', 'c', 'd'],
  )
  assert.equal(reviewItemState(afterDel, del), 'applied')

  const off = { ...del, id: 'c', action: 'disable' as const }
  const afterOff = applyReviewItem(ls, off)
  assert.equal(afterOff.find((l) => l.id === 'c')!.enabled, false)
  assert.equal(reviewItemState(afterOff, off), 'applied')

  const rw = {
    ...del,
    id: 'b',
    action: 'rewrite' as const,
    why: '写成了事件',
    title: '新规则',
    rule: '',
    tags: ['测试 '],
  }
  const afterRw = applyReviewItem(ls, rw, '2026-10-25T00:00:00.000Z')
  const b = afterRw.find((l) => l.id === 'b')!
  assert.equal(b.title, '新规则')
  // 没给的说明沿用原来的，旧版本进改写记录
  assert.equal(b.rule, '说明 b')
  assert.deepEqual(b.tags, ['测试'])
  assert.equal(b.history[0].title, '规则 b')
  assert.match(b.history[0].why, /AI 评审改写：写成了事件/)
  assert.equal(reviewItemState(afterRw, rw), 'applied')

  const mg = { ...del, id: 'c', action: 'merge' as const, title: '合并', merge: ['d'] }
  const afterMg = applyReviewItem(ls, mg)
  assert.deepEqual(
    afterMg.map((l) => l.id),
    ['a', 'b', 'c'],
  )
  assert.equal(reviewItemState(afterMg, mg), 'applied')
  // 要改的那条不在了：原样返回，标成已不在
  assert.equal(applyReviewItem(afterDel, { ...rw, id: 'a' }), afterDel)
  assert.equal(reviewItemState(afterDel, { ...rw, id: 'a' }), 'missing')
})

test('评审提示：只读、不调 record_lesson、只查教训点名的东西，带重点', () => {
  const p = lessonReviewPrompt('商城', 3, '测试相关')
  assert.match(p, /只读评审/)
  assert.match(p, /不要调用 record_lesson/)
  assert.match(p, /不通读整个项目/)
  assert.match(p, new RegExp('```' + LESSON_REVIEW_LANG))
  assert.match(p, /这次重点看：测试相关/)
})

test('默认页签：不带标签的在「默认」，带标签的在每个标签页签里，默认在最前', () => {
  const ls = [L('a'), L('b', { tags: ['测试', '并发'] }), L('c', { tags: ['测试'] })]
  assert.equal(inTab(ls[0], DEFAULT_TAB), true)
  assert.equal(inTab(ls[1], DEFAULT_TAB), false)
  assert.deepEqual(lessonTabs(ls, tagCounts(ls)), [
    [DEFAULT_TAB, 1],
    ['测试', 2],
    ['并发', 1],
  ])
  // 搜索时数字按命中的算，页签还是全部标签
  assert.deepEqual(lessonTabs([ls[2]], tagCounts(ls)), [
    [DEFAULT_TAB, 0],
    ['测试', 1],
    ['并发', 0],
  ])
})
