/**
 * 用户放行的登记（ADR 0070）：门禁拦下时记下「拦了什么」，用户在 request_override 弹的卡片上同意后，
 * 同一个门禁在这个对话里放行一次。放行只认用户点的卡片，拦下的内容也由面板自己记，卡片上不显示 Agent 自报的操作。
 * 只在内存里：放行只管这一回合附近的那一次操作，服务重启后 CLI 进程也不在了，不用存盘（Task 上只放要存盘的数据）
 */
import type { HookFacts } from '../../shared/hooks/index.ts'
import { ruleAllowed } from '../../shared/allow-rules.ts'
import { gateRule } from '../../shared/grants/kinds.ts'
import type { Task } from '../../shared/schema.ts'
import { AFTER_GRANT, overrideTip } from '../../shared/hooks/override.ts'
import { t } from '../../shared/i18n.ts'
import { panelRequest, type RequestCtx } from '../exec/panel-requests.ts'
import { taskLog } from '../tasks/log.ts'

interface Blocked {
  /** 门禁的显示名（卡片标题用） */
  name: string
  /** 被拦下的操作：命令原文、要改的文件；收尾门禁没有 */
  target: string
  /** 门禁给的原因（不含放行提示） */
  reason: string
  at: number
}

/** 放行有效期：同意后 Agent 马上重试，过了这么久还没用就作废，免得挂着放行到很久以后的另一次操作 */
const GRANT_MS = 10 * 60_000

// 对话 id → 门禁 → 最近一次拦下的记录 / 用户同意放行的时间
// 模块状态：运行时，钩子和 request_override 共用；重启后作废（CLI 进程也不在了，放行本来就只管眼前这一次）
const blocked = new Map<string, Map<string, Blocked>>()
// 模块状态：运行时，同上
const grants = new Map<string, Map<string, number>>()

const mapOf = <V>(m: Map<string, Map<string, V>>, taskId: string) => {
  let x = m.get(taskId)
  if (!x) m.set(taskId, (x = new Map()))
  return x
}

/** 被拦下的是什么：命令取原文，改文件取路径 */
export function targetOf(facts: HookFacts | undefined): string {
  const tool = facts?.tool
  if (!tool) return ''
  if (tool.kind === 'shell') return String(tool.input.command ?? '').trim()
  const paths = (tool.paths.length ? tool.paths : [tool.path]).filter(Boolean)
  return paths.length ? paths.join('\n') : tool.name
}

/** 门禁拦下时要看的对话：id 认放行登记，allowRules 认「本对话不再询问」（存盘的，重启后照样有效） */
type GateTask = Pick<Task, 'id'> & { allowRules?: readonly string[] }

/**
 * 门禁拦下时调：用户在卡片上选过「本对话不再询问」就一直放行；放行过一次（还没用掉、没过期）就用掉这次放行。
 * 放行都返回空串；否则记下拦了什么，返回原因加上「用户要求的就请用户放行」那一句
 */
export function gateDeny(task: GateTask, gate: string, name: string, target: string, reason: string): string {
  if (!reason) return ''
  const taskId = task.id
  if (ruleAllowed(task.allowRules ?? [], gateRule(gate))) {
    taskLog(taskId, '用户选过本对话不再询问，门禁不拦', { gate, target: target.slice(0, 200) })
    return ''
  }
  const mine = grants.get(taskId)
  const at = mine?.get(gate)
  if (at !== undefined) {
    mine!.delete(gate)
    if (Date.now() - at <= GRANT_MS) {
      taskLog(taskId, '用户放行，门禁这一次不拦', { gate, target: target.slice(0, 200) })
      return ''
    }
  }
  mapOf(blocked, taskId).set(gate, { name, target, reason, at: Date.now() })
  return reason + overrideTip(gate)
}

/** 对话结束、删除时清掉（server 侧调用；漏清也只占一点内存，放行有有效期） */
export function clearOverrides(taskId: string) {
  blocked.delete(taskId)
  grants.delete(taskId)
}

/**
 * request_override：弹卡请用户放行这个门禁刚拦下的那次操作。卡片上的操作和原因取面板记下的，
 * 用户的要求取 Agent 转述的（标明是 Agent 说的）。同意后记下放行，Agent 重试同一个操作时放行一次
 */
export async function overrideRequest(
  ctx: RequestCtx,
  input: { gate: string; reason: string },
  own?: Set<string>,
): Promise<{ ok: boolean; info: string }> {
  const gate = input.gate.trim()
  const b = blocked.get(ctx.task.id)?.get(gate)
  if (!b)
    return {
      ok: false,
      info: `这个对话里「${gate || '（没写 gate）'}」最近没有拦过你：gate 填拦下你的那条说明里给的名字；没被拦就照常做，不用请求放行。`,
    }
  if (!input.reason.trim())
    return { ok: false, info: 'reason 必填：写用户的原话或怎么要求的，用户要看到你凭什么请求放行。' }
  const r = await panelRequest(
    ctx,
    {
      step: '',
      agentId: '',
      kind: 'tool',
      purpose: 'override',
      title: t('Agent 请求放行：{name}', { name: b.name }),
      detail: [
        b.target ? t('被拦下的操作：\n{target}', { target: b.target.slice(0, 2000) }) : '',
        t('门禁的原因：{reason}', { reason: b.reason.replace(/^【面板】/, '').slice(0, 600) }),
        t('Agent 说你要求的：{reason}', { reason: input.reason.trim().slice(0, 600) }),
        t('「允许一次」只放行这一次；「本对话不再询问」之后这个对话里这个门禁都不再拦。'),
      ]
        .filter(Boolean)
        .join('\n\n'),
      // 同一类 = 同一个门禁（shared/grants/kinds.ts）；卡上给不给「本对话不再询问」由页面按设置决定
      rule: gateRule(gate),
      ruleLabel: t('「{name}」拦下的操作', { name: b.name }),
    },
    own,
  )
  if (!r) return { ok: false, info: '请求作废了（对话被停止）：没有放行。' }
  if (!r.allow)
    return {
      ok: false,
      info: `用户没有放行${r.message ? `，说：${r.message}` : ''}。按门禁说的做，不要绕开。`,
    }
  blocked.get(ctx.task.id)?.delete(gate)
  const extra = AFTER_GRANT[gate] ? ` ${AFTER_GRANT[gate]}` : ''
  // 本对话不再询问：规则记进对话（回答接口的 applyAnswer 也会记，这里再记一次，不依赖回答从哪条路进来）
  if (r.always) {
    const rule = gateRule(gate)
    const rules = ctx.task.allowRules ?? []
    if (!rules.includes(rule)) ctx.task.allowRules = [...rules, rule]
    taskLog(ctx.task.id, '用户选了本对话不再询问', { gate, target: b.target.slice(0, 200) })
    return {
      ok: true,
      info: `用户同意放行「${b.name}」，并且这个对话里之后都不再拦${r.message ? `（用户补充：${r.message}）` : ''}：现在重试刚才被拦下的那个操作。${extra}`,
    }
  }
  mapOf(grants, ctx.task.id).set(gate, Date.now())
  taskLog(ctx.task.id, '用户同意放行', { gate, target: b.target.slice(0, 200) })
  return {
    ok: true,
    info: `用户同意放行「${b.name}」这一次${r.message ? `（用户补充：${r.message}）` : ''}：现在重试刚才被拦下的那个操作，10 分钟内有效，只放行一次。${extra}`,
  }
}
