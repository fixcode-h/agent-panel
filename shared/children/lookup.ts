/**
 * 父对话查名下的子对话：计划按它对上等待、收口（kidsOf），补步骤时取标题（kidTitleOf），
 * 新建子对话前判断是不是在重试一个失败、中断的子对话（retryTarget）。从 engine.ts 拆出来（行数上限，按功能拆）
 */
import type { EngineHost } from '../engine-host.ts'
import type { PlanKid } from '../plan.ts'
import { convStateText } from '../task.ts'

/**
 * 这个对话名下的子对话（计划按它对上等待、收口）：set_plan、finish_plan 都按这一份算。
 * 取不到列表时当没有子对话（老版本宿主），不影响计划本身
 */
export async function kidsOf(host: EngineHost): Promise<PlanKid[]> {
  const list = host.listConversations ? await host.listConversations().catch(() => []) : []
  return list.map((c) => ({
    id: c.id,
    title: c.title,
    createdAt: c.createdAt ?? '',
    done: !!c.resolved,
    endedAt: c.resolved ? c.at : '',
  }))
}

/** 一个子对话的标题：取不到时返回空串（调用方退到用 id） */
export async function kidTitleOf(host: EngineHost, id: string) {
  const list = host.listConversations ? await host.listConversations().catch(() => []) : []
  return list.find((c) => c.id === id)?.title.trim() ?? ''
}

/** 去掉标题里「（重试）」「重试 2」「(retry)」这类标记，比较是不是同一件事 */
export const retryBase = (title: string) =>
  title
    .replace(/[（(【[]\s*(?:第\s*\d+\s*次)?\s*(?:重试|再试|retry)\s*\d*\s*[）)】\]]/gi, '')
    .replace(/\s*[-—:：·|｜]?\s*(?:重试|再试|retry)\s*\d*\s*$/i, '')
    .trim()

/**
 * 新建子对话其实是在重试一个失败、中断的子对话：标题去掉重试标记后和它一样。
 * 返回那个子对话，父对话应该用 send_to_conversation 交回给它
 */
export async function retryTarget(host: EngineHost, title: string) {
  if (!host.listConversations) return undefined
  const base = retryBase(title)
  if (!base) return undefined
  const ended = new Set([convStateText('failed'), convStateText('stopped')])
  const list = await host.listConversations().catch(() => [])
  return list.find((c) => !c.resolved && !c.busy && ended.has(c.status) && retryBase(c.title) === base)
}
