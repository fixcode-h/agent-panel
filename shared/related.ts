import type { Task } from './schema.ts'

/**
 * 新要求和已有对话的关联程度：项目首页输入时，提示「这件事可能接着某个对话做更合适」。
 * 只在本地按字面算（中文按相邻两字、英文按单词），不调模型，输入时就能实时给出；
 * 判断不准也只是一条提示，发到哪里由用户点。
 */
function grams(text: string) {
  const out = new Set<string>()
  const s = text.toLowerCase()
  for (const w of s.match(/[a-z0-9_.-]{3,}/g) ?? []) out.add(w)
  for (const run of s.match(/[一-鿿]+/g) ?? []) {
    if (run.length === 1) continue
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2))
  }
  return out
}

/** 常见的口头用语：几乎每条要求都有，不算关联 */
const COMMON = new Set([
  '一下',
  '帮我',
  '我们',
  '这个',
  '那个',
  '现在',
  '需要',
  '可以',
  '看看',
  '修改',
  '问题',
  '一个',
  '下这',
  '功能',
  '没有',
  '什么',
  '怎么',
  '是否',
  '还有',
  '然后',
  '优化',
  '实现',
  '增加',
  '添加',
  '处理',
])

export interface RelatedTask {
  task: Task
  score: number
}

/** 按关联程度从高到低给出最多 limit 个对话；太弱的不给 */
export function relatedTasks(text: string, tasks: Task[], limit = 3): RelatedTask[] {
  const q = [...grams(text)].filter((g) => !COMMON.has(g))
  if (q.length < 2) return []
  return tasks
    .map((task) => {
      const first = task.messages.find((m) => m.role === 'user')?.text ?? ''
      const mine = grams(`${task.title}\n${task.summary}\n${first}`)
      const hit = q.filter((g) => mine.has(g)).length
      // 按要求本身的长度归一：长要求里命中几个词不算多
      return { task, hit, score: hit / Math.sqrt(q.length) }
    })
    .filter((x) => x.hit >= 2 && x.score >= 0.6)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ task, score }) => ({ task, score }))
}
