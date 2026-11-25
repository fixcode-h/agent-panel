/**
 * 插件工具请用户确认（McpCallContext.confirm，插件接口 2 / 17）：走面板自己的「允许 / 拒绝」请求卡片，和推送授权同一种。
 * 插件给了 rule 时卡片上多一个「这个对话里一直允许」：选了记成对话的放行规则 `plugin:<插件 id>:<键>`（插件 id 由
 * server/plugins/mcp.ts 加上；和 CLI 审批卡的「一直允许」同一处 task.allowRules），之后同一个键直接允许、对话里留一行记录，不再出卡。
 * 从 plugin-run.ts 拆出：那边只管挂工具
 */
import { ruleAllowed } from '../../shared/allow-rules.ts'
import { t } from '../../shared/i18n.ts'
import { presetFor } from '../../shared/grants/preset.ts'
import type { PluginConfirm, PluginConfirmResult } from '../plugins/sdk.ts'
import { panelRequest, type RequestCtx } from './panel-requests.ts'
import { systemNote } from './recovery.ts'

/** 插件确认的放行规则：和 CLI 的 command: / file: / tool: 分开，`<插件 id>:<插件定的键>` 原样接在后面 */
export const pluginRule = (key: string) => (key.trim() ? `plugin:${key.trim()}` : '')

export async function pluginConfirm(
  ctx: RequestCtx,
  run: { step: string; agentId: string },
  req: PluginConfirm,
  own: Set<string>,
): Promise<PluginConfirmResult> {
  const { task } = ctx
  const rule = req.rule ? pluginRule(req.rule) : ''
  const label = req.ruleLabel?.trim() || ''
  // 工作流自带的授权（WorkflowFields.grants）：运行里不弹卡，和「一直允许」一样留一行，写明是哪个工作流给的
  const preset = presetFor(task, rule)
  if (preset) {
    task.messages.push(
      systemNote(
        ctx.newId(),
        run.agentId,
        run.step,
        t('工作流「{name}」自带授权，自动允许（{rule}）：{title}', {
          name: task.workflowName || task.flowRun?.workflowName || '',
          rule: preset.label || label || rule,
          title: req.title,
        }),
      ),
    )
    ctx.changed()
    return { allow: true, always: true, message: '' }
  }
  // 用户之前在这个对话里选过「一直允许」：直接允许，自动允许的也要看得见，对话里留一行
  if (rule && ruleAllowed(task.allowRules ?? [], rule)) {
    task.messages.push(
      systemNote(
        ctx.newId(),
        run.agentId,
        run.step,
        t('按这个对话的放行规则自动允许（{rule}）：{title}', { rule: label || rule, title: req.title }),
      ),
    )
    ctx.changed()
    return { allow: true, always: true, message: '' }
  }
  const r = await panelRequest(
    ctx,
    {
      step: run.step,
      agentId: run.agentId,
      kind: 'tool',
      title: req.title,
      detail: req.detail ?? '',
      ...(req.diff ? { diff: req.diff } : {}),
      ...(rule ? { rule, ...(label ? { ruleLabel: label } : {}) } : {}),
    },
    own,
  )
  // 停止对话时请求作废（null）：按拒绝处理，插件那边不会写入
  return {
    allow: !!r?.allow,
    ...(r?.allow && r.always && rule ? { always: true } : {}),
    message: r?.message ?? r?.answer ?? '',
  }
}
