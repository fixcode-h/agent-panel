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
      ok: !!cli?.installed,
      label: 'CLI 已安装',
      hint: cli?.installed ? `${cli.name} ${cli.version?.split(' ')[0] ?? ''}` : `安装 ${cli?.name ?? a.cli} 后才能运行`,
    },
    { ok: a.enabled, label: '已启用', hint: a.enabled ? '可以被工作流调用' : '停用后工作流不会调用它' },
    { ok: !!a.model, label: '已指定模型', hint: a.model || '留空会使用 CLI 默认模型', optional: true },
    { ok: !!instr, label: '已写角色设定', hint: instr ? `共 ${instr.length} 字` : '建议写清楚它的职责和交付标准', optional: true },
  ]
}

/** 文档里的 @提及：@ 后面到空白或标点为止 */
export function parseMentions(doc: string): string[] {
  return [...new Set([...doc.matchAll(/@([^\s@#，。、,.;；:：()（）\[\]【】]+)/g)].map((m) => m[1]))]
}

export function workflowChecks(w: Workflow, agents: Agent[], clis: CliStatus[]): Check[] {
  const byId = new Map(agents.map((a) => [a.id, a]))
  const main = byId.get(w.mainAgentId)
  const team = [main, ...w.members.map((m) => byId.get(m.agentId))].filter(Boolean) as Agent[]
  const teamNames = new Set(team.map((a) => a.name))
  const mentions = parseMentions(w.document)
  const unknown = mentions.filter((m) => !teamNames.has(m))
  const unassigned = w.members.map((m) => byId.get(m.agentId)).filter((a) => a && !mentions.includes(a.name)) as Agent[]
  const notRunnable = team.filter((a) => !a.enabled || !clis.find((c) => c.id === a.cli)?.installed)

  return [
    { ok: !!main, label: '已选择主 Agent', hint: main ? main.name : '主 Agent 负责按文档推进并分派步骤' },
    {
      ok: notRunnable.length === 0,
      label: '团队成员都可运行',
      hint: notRunnable.length ? `${notRunnable.map((a) => a.name).join('、')} 已停用或 CLI 未安装` : `共 ${team.length} 个 Agent`,
    },
    { ok: !!w.document.trim(), label: '已写工作流文档', hint: w.document.trim() ? `共 ${w.document.trim().length} 字` : '写清楚按什么步骤执行' },
    {
      ok: unknown.length === 0,
      label: '文档引用的 Agent 都在团队中',
      hint: unknown.length ? `不在团队中：${unknown.map((n) => '@' + n).join('、')}` : '用 @名称 指定步骤由谁执行',
    },
    {
      ok: unassigned.length === 0,
      label: '每个子 Agent 都有分派',
      hint: unassigned.length ? `文档里没提到：${unassigned.map((a) => a.name).join('、')}` : '子 Agent 都在文档中出现',
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
