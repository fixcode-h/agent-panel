import { randomUUID } from 'node:crypto'
import type { Task, TaskMessage } from '../../../shared/schema.ts'
import { steerTask } from '../../exec/steering.ts'
import { t } from '../../../shared/i18n.ts'
import { RULE_CMD } from '../helpers.ts'
import type { TasksScope } from '../scope.ts'

/**
 * 「/rule 内容」发布一条全局规则；「/rule」不带内容列出现有规则；「/rule clear」清空，「/rule -2」删掉第 2 条。
 * 只有项目里的顶层对话能用：规则存在这个对话上，名下所有子对话（连同它们的工作流节点）每次调用都带上，
 * 正在执行的子对话马上收到。不写进项目的 AGENTS.md
 */
export async function ruleCommand(
  sc: TasksScope,
  id: string,
  text: string,
): Promise<{ task: Task } | { error: string }> {
  const entry = sc.live.get(id)
  const tk = entry?.task ?? (await sc.store.get(id))
  if (!tk) return { error: t('任务不存在') }
  if (!tk.projectId || tk.parentTaskId)
    return { error: t('全局规则只能在项目对话里发布，子对话会自动遵守父对话的规则') }
  const arg = text.replace(RULE_CMD, '').trim()
  const at = new Date().toISOString()
  let note: string
  let fresh = ''
  if (!arg) {
    note = tk.rules.length
      ? t('这个对话的全局规则：\n{list}', { list: tk.rules.map((r, i) => `${i + 1}. ${r.text}`).join('\n') })
      : t('这个对话还没有全局规则。输入「/rule 内容」发布一条，所有子对话都会遵守。')
  } else if (/^(clear|清空)$/i.test(arg)) {
    tk.rules = []
    note = t('已清空全局规则')
  } else if (/^-\d+$/.test(arg)) {
    const n = Number(arg.slice(1))
    const gone = tk.rules[n - 1]
    if (!gone) return { error: t('没有第 {n} 条规则', { n }) }
    tk.rules = tk.rules.filter((_, i) => i !== n - 1)
    note = t('已删除全局规则：{text}', { text: gone.text })
  } else {
    tk.rules = [...tk.rules, { id: randomUUID(), text: arg.slice(0, 2000), at }]
    fresh = arg
    note = t('已发布全局规则：{text}。这个对话下的所有子对话都会遵守，不写进项目的 AGENTS.md。', { text: arg })
  }
  tk.messages.push({ id: randomUUID(), role: 'system', agentId: '', step: '', text: note, tools: [], at })
  tk.updatedAt = at
  if (entry) entry.rev++
  await sc.store.update(tk.id, tk)
  // 正在执行的子对话马上收到新规则；没在执行的下一轮开始时从父对话读
  if (fresh)
    for (const k of [...sc.live.values()].filter((e) => e.task.parentTaskId === tk.id && e.task.working)) {
      const body = `父对话发布了新的全局规则，接下来必须遵守：${fresh}`
      const msg: TaskMessage = {
        id: randomUUID(),
        role: 'system',
        agentId: '',
        step: '',
        text: body,
        tools: [],
        peer: await sc.peerOf(tk, 'parent', 'rule', fresh),
        at,
      }
      const how = await steerTask(k.task, body, msg).catch(() => false)
      if (!how) k.task.messages.push(msg)
      k.rev++
    }
  return { task: tk }
}
