/**
 * 开跑时推的技能（ADR 0083，设计稿 9.2）：开跑时就知道的条件——项目特征（项目根下有 *.uproject）、
 * 用户这条消息里写到的路径和附件、角色 / 节点参数（「开发」的 lang=lua）、Bug 模式——对上的技能正文接在这一轮输入后面。
 * 用户打「/名字」点名的技能由「/」展开带了正文（server/slash.ts），这里只记进推送记录，之后不再推。
 * 同一技能一个对话只推一次、总量上限，和工具调用时推的同一套（./push.ts）。只看用户的消息和面板状态，不看模型回复
 */
import { readdir } from 'node:fs/promises'
import type { Task } from '../../shared/schema.ts'
import { whenMatchesLaunch, whenReason, pathsInText, type SkillLaunchFacts } from '../../shared/skills/when.ts'
import { readHooks } from '../hooks/store.ts'
import { pluginSkillsFor } from './plugin-skills.ts'
import { catalogFor, pushSkill, skillPushBudget, skillPushOn } from './push.ts'
import { pushedSkills, recordSkillPush } from './push-ledger.ts'
import type { RealContext } from '../exec/real-context.ts'

export interface LaunchPushArgs {
  ctx: Pick<RealContext, 'task' | 'project' | 'prompt'>
  cwd: string
  params: Record<string, unknown>
  /** 推了一个技能（会话栏记下来） */
  onPushed?: (name: string) => void
}

/** 用户这条消息带的附件路径（最后一条用户消息） */
const attachmentsOf = (task: Task) =>
  ([...task.messages].reverse().find((m) => m.role === 'user')?.attachments ?? []).map((a) => a.path || a.name)

export async function launchSkillPush(a: LaunchPushArgs): Promise<string> {
  const { task, project, prompt } = a.ctx
  const data = await readHooks()
  if (!skillPushOn(data, project.id)) return ''
  const catalog = catalogFor(data, await pluginSkillsFor(project).catch(() => []))
  const c = { taskId: task.id, budget: skillPushBudget(data), catalog, onPushed: a.onPushed }
  // 「/名字」点名的技能：展开时已经带了正文，记一笔就行
  const slash = /^\/([^\s/]+)/.exec(prompt.trim())?.[1]
  if (slash && catalog.some((s) => s.name === slash) && !pushedSkills(task.id).has(slash)) {
    recordSkillPush(task.id, { skill: slash, chars: 0, tokens: 0, at: new Date().toISOString(), trigger: 'slash' })
    a.onPushed?.(slash)
  }
  const facts: SkillLaunchFacts = {
    projectFiles: await readdir(a.cwd).catch(() => []),
    messagePaths: [...pathsInText(prompt), ...attachmentsOf(task)],
    params: a.params,
    bug: !!task.bug,
  }
  const out: string[] = []
  for (const s of catalog) {
    if (!s.on) continue
    const w = s.when.find((x) => whenMatchesLaunch(x, facts))
    if (!w) continue
    const text = await pushSkill(c, s.name, whenReason(w), `${w.kind} ${w.value}`)
    if (text) out.push(text)
  }
  return out.join('\n\n')
}
