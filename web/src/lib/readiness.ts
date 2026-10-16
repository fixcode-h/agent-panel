import type { Agent, CliStatus, DirInfo, Workflow } from '@shared/schema'

export interface Check {
  ok: boolean
  label: string
  hint: string
  /** 可选项未满足时只提示，不算未就绪 */
  optional?: boolean
}

export const isReady = (checks: Check[]) => checks.every((c) => c.ok || c.optional)

export function agentChecks(a: Agent, cli?: CliStatus): Check[] {
  const instr = a.instructions.trim()
  return [
    {
      ok: !!cli?.installed && cli.enabled,
      label: 'CLI 已安装',
      hint: !cli ? `未知的 CLI：${a.cli}` : !cli.enabled ? `${cli.name} 已在设置中停用` : cli.installed ? `${cli.name} ${cli.version?.split(' ')[0] ?? ''}` : `没有找到 ${cli.command}，安装后或在设置里填写路径`,
    },
    { ok: a.enabled, label: '已启用', hint: a.enabled ? '可以被工作流调用' : '停用后工作流不会调用它' },
    { ok: !!a.model, label: '已指定模型', hint: a.model || '留空会使用设置里的默认模型', optional: true },
    { ok: !!instr, label: '已写角色设定', hint: instr ? `共 ${instr.length} 字` : '建议写清楚它的职责和交付标准', optional: true },
  ]
}

export function workflowChecks(w: Workflow, agents: Agent[], clis: CliStatus[]): Check[] {
  const byId = new Map(agents.map((a) => [a.id, a]))
  const main = byId.get(w.mainAgentId)
  const team = [main, ...w.members.map((m) => byId.get(m.agentId))].filter(Boolean) as Agent[]
  const teamIds = new Set(team.map((a) => a.id))
  const nodes = w.stages.flatMap((s) => s.nodes)
  const outside = [...new Set(nodes.filter((n) => n.agentId && !teamIds.has(n.agentId)).map((n) => n.title || '未命名节点'))]
  const emptyStages = w.stages.filter((s) => !s.nodes.length).length
  const used = new Set(nodes.map((n) => n.agentId))
  const unassigned = w.members.map((m) => byId.get(m.agentId)).filter((a) => a && !used.has(a.id)) as Agent[]
  const notRunnable = team.filter((a) => {
    const c = clis.find((x) => x.id === a.cli)
    return !a.enabled || !c?.installed || !c.enabled
  })
  const parallel = w.stages.filter((s) => s.nodes.length > 1).length

  return [
    { ok: !!main, label: '已选择主 Agent', hint: main ? main.name : '主 Agent 执行没指定 Agent 的节点，并处理追加要求' },
    {
      ok: notRunnable.length === 0,
      label: '团队成员都可运行',
      hint: notRunnable.length ? `${notRunnable.map((a) => a.name).join('、')} 已停用或 CLI 未安装` : `共 ${team.length} 个 Agent`,
    },
    {
      ok: nodes.length > 0 && emptyStages === 0,
      label: '已设计流程',
      hint: !nodes.length
        ? '在流程图里添加阶段和节点'
        : emptyStages
          ? `有 ${emptyStages} 个阶段还没有节点`
          : `${w.stages.length} 个阶段、${nodes.length} 个节点${parallel ? `，${parallel} 个阶段并行` : ''}`,
    },
    {
      ok: outside.length === 0,
      label: '节点的 Agent 都在团队中',
      hint: outside.length ? `这些节点的 Agent 不在团队里：${outside.join('、')}` : '没指定 Agent 的节点由主 Agent 执行',
    },
    {
      ok: unassigned.length === 0,
      label: '每个子 Agent 都有节点',
      hint: unassigned.length ? `没有分到节点：${unassigned.map((a) => a.name).join('、')}` : '子 Agent 都参与了流程',
      optional: true,
    },
    {
      ok: !!w.document.trim(),
      label: '已写工作流说明',
      hint: w.document.trim() ? `共 ${w.document.trim().length} 字` : '写清楚目标、规范和完成标准，每个节点都会看到',
      optional: true,
    },
  ]
}

export function projectChecks(
  p: { path: string },
  dir: DirInfo | null,
  workflow: Workflow | undefined,
  agents: Agent[],
  clis: CliStatus[],
): Check[] {
  const dirOk = !!dir?.exists && dir.isDir
  return [
    {
      ok: dirOk,
      label: '本地目录可用',
      hint: !p.path.trim() ? '还没有选择目录' : dirOk ? dir!.path : '目录不存在或不是文件夹',
    },
    {
      ok: !!dir?.gitBranch,
      label: '是 git 仓库',
      hint: dir?.gitBranch ? `当前分支 ${dir.gitBranch}` : '建议用 git 管理，方便查看和回退 Agent 的改动',
      optional: true,
    },
    { ok: !!workflow, label: '已指定工作流', hint: workflow ? workflow.name : '在项目或项目分类上指定' },
    {
      ok: !!workflow && isReady(workflowChecks(workflow, agents, clis)),
      label: '工作流已就绪',
      hint: !workflow ? '先指定工作流' : isReady(workflowChecks(workflow, agents, clis)) ? '可以执行' : '到工作流页面查看未通过的检查',
    },
  ]
}
