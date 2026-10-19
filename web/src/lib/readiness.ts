import { shortVersion } from './cli-style'
import { DEFAULT_AGENT_ID, type Agent, type CliStatus, type DirInfo, type Workflow } from '@shared/schema'
import { entryFlow, findRefCycle, flowLabel, getFlow, reachable, refsOf, topoOrder } from '@shared/flow'
import { t } from '@shared/i18n'
import { nodeMissingParams, paramLabel } from '@shared/agent-role'

export interface Check {
  ok: boolean
  label: string
  hint: string
  /** 可选项未满足时只提示，不算未就绪 */
  optional?: boolean
}

export const isReady = (checks: Check[]) => checks.every((c) => c.ok || c.optional)

/** Agent 实际用的 CLI 的检测结果：没选 CLI 时是设置里的默认 CLI */
export const cliFor = (a: { cli: string }, clis: CliStatus[]) =>
  a.cli ? clis.find((c) => c.id === a.cli) : (clis.find((c) => c.isDefault) ?? clis[0])

export function agentChecks(a: Agent, cli?: CliStatus): Check[] {
  const instr = a.instructions.trim()
  return [
    {
      ok: !!cli?.installed && cli.enabled,
      label: t('CLI 已安装'),
      hint: !cli
        ? t('未知的 CLI：{cli}', { cli: a.cli })
        : !cli.installed
          ? t('没有找到 {cmd}，安装后或在设置里填写路径', { cmd: cli.command })
          : !cli.enabled
            ? t('{cli} 已在设置中停用', { cli: cli.name })
            : `${cli.name} ${shortVersion(cli.version)}`,
    },
    { ok: a.enabled, label: t('已启用'), hint: a.enabled ? t('可以被工作流调用') : t('停用后工作流不会调用它') },
    // 自带的默认 Agent 固定跟随默认 CLI 的默认模型，不能指定，这一项对它没有意义
    a.id !== DEFAULT_AGENT_ID && {
      ok: !!a.model,
      label: t('已指定模型或档位'),
      hint: a.model.startsWith('@') ? t('按设置里的档位选择模型') : a.model || t('留空会使用设置里的默认模型'),
      optional: true,
    },
    {
      ok: !!instr,
      label: t('已写角色设定'),
      hint: instr ? t('共 {n} 字', { n: instr.length }) : t('建议写清楚它的职责和交付标准'),
      optional: true,
    },
  ].filter((c): c is Check => !!c)
}

export function workflowChecks(w: Workflow, agents: Agent[], clis: CliStatus[], workflows: Workflow[] = []): Check[] {
  const byId = new Map(agents.map((a) => [a.id, a]))
  const main = byId.get(w.mainAgentId)
  const nodes = w.flows.flatMap((f) => f.nodes)
  // 子 Agent 在节点上选：用到的 Agent 就是主 Agent 加上节点上的
  const used = [...new Set(nodes.filter((n) => n.kind === 'agent' && n.agentId).map((n) => n.agentId))]
  const team = [main, ...used.filter((id) => id !== w.mainAgentId).map((id) => byId.get(id))].filter(Boolean) as Agent[]
  const missing = [
    ...new Set(
      nodes
        .filter((n) => n.kind === 'agent' && n.agentId && !byId.has(n.agentId))
        .map((n) => n.title || t('未命名节点')),
    ),
  ]
  // 工作流里的节点都用默认 CLI 执行，看默认 CLI 能不能用
  const defCli = clis.find((c) => c.isDefault) ?? clis[0]
  const cliOk = !clis.length || (!!defCli?.installed && defCli.enabled)
  const notRunnable = team.filter((a) => !a.enabled)
  // 节点上必填（没有默认值）的参数还没填
  const lacking = nodes.flatMap((n) => {
    if (n.kind !== 'agent') return []
    const miss = nodeMissingParams(byId.get(n.agentId || w.mainAgentId), n.params)
    return miss.length ? [`${n.title || t('未命名节点')}（${miss.map(paramLabel).join(t('、'))}）`] : []
  })
  const entry = entryFlow(w)
  const live = topoOrder(entry)
  const loose = w.flows.flatMap((f) => {
    const r = reachable(f)
    return f.nodes.filter((n) => !r.has(n.id)).map((n) => `${flowLabel(f, w)} · ${n.title || t('未命名节点')}`)
  })
  const emptyFlowNode = nodes.filter((n) => n.kind === 'flow' && !n.flow).map((n) => n.title || t('未命名节点'))
  const all = workflows.some((x) => x.id === w.id) ? workflows.map((x) => (x.id === w.id ? w : x)) : [w, ...workflows]
  const cycle = findRefCycle(w, all)
  const broken = w.flows.flatMap((f) =>
    refsOf(f)
      .filter((r) =>
        r.kind === 'sub' ? !getFlow(w, r.id) : workflows.length > 0 && !workflows.some((x) => x.id === r.id),
      )
      .map(() => flowLabel(f, w)),
  )
  const hooks = nodes.filter((n) => n.hooks.review).length
  const subs = w.flows.length - 1

  return [
    {
      ok: !!main,
      label: t('已选择主 Agent'),
      hint: main ? main.name : t('主 Agent 执行没指定 Agent 的节点，并处理追加要求'),
    },
    {
      ok: notRunnable.length === 0 && cliOk,
      label: t('团队成员都可运行'),
      hint: !cliOk
        ? t('节点都用默认 CLI 执行，{cli} 未安装或已停用', { cli: defCli?.name ?? '' })
        : notRunnable.length
          ? t('{names} 已停用', { names: notRunnable.map((a) => a.name).join(t('、')) })
          : t('共 {n} 个 Agent', { n: team.length }),
    },
    {
      ok: lacking.length === 0,
      label: t('节点参数已填写'),
      hint: lacking.length
        ? t('这些节点还有必填参数没填：{names}', { names: lacking.slice(0, 3).join(t('、')) })
        : t('没有缺少的参数'),
    },
    {
      ok: live.length > 0 && emptyFlowNode.length === 0,
      label: t('已设计流程'),
      hint: !live.length
        ? t('从「开始」连一条线到{flow}的第一个节点', { flow: flowLabel(entry, w) })
        : emptyFlowNode.length
          ? t('这些流程节点还没选流程：{names}', { names: emptyFlowNode.join(t('、')) })
          : t('{n} 个节点', { n: live.length }) +
            (subs ? t('、{n} 个子流程', { n: subs }) : '') +
            (hooks ? t('，{n} 个节点带验收', { n: hooks }) : ''),
    },
    {
      ok: !cycle && broken.length === 0,
      label: t('流程引用正常'),
      hint: cycle
        ? t('流程循环调用：{cycle}', { cycle: cycle.join(' → ') })
        : broken.length
          ? t('{names} 引用的流程已经删除', { names: [...new Set(broken)].join(t('、')) })
          : t('没有循环调用'),
    },
    {
      ok: missing.length === 0,
      label: t('节点的 Agent 都还在'),
      hint: missing.length
        ? t('这些节点的 Agent 已经删除：{names}', { names: missing.join(t('、')) })
        : t('没指定 Agent 的节点由主 Agent 执行'),
    },
    {
      ok: loose.length === 0,
      label: t('节点都已连上'),
      hint: loose.length
        ? t('没有从开始连到、不会执行：{names}', { names: loose.slice(0, 4).join(t('、')) })
        : t('所有节点都会执行'),
      optional: true,
    },
    {
      ok: !!w.document.trim(),
      label: t('已写工作流说明'),
      hint: w.document.trim()
        ? t('共 {n} 字', { n: w.document.trim().length })
        : t('写清楚目标、规范和完成标准，每个节点都会看到'),
      optional: true,
    },
  ]
}

export function projectChecks(
  p: { path: string },
  /** undefined：还在检查 */
  dir: DirInfo | null | undefined,
  workflow: Workflow | undefined,
  agents: Agent[],
  clis: CliStatus[],
): Check[] {
  const dirOk = !!dir?.exists && dir.isDir
  const checking = dir === undefined && !!p.path.trim()
  return [
    {
      ok: dirOk || checking,
      label: t('本地目录可用'),
      hint: !p.path.trim()
        ? t('还没有选择目录')
        : checking
          ? t('正在检查…')
          : dirOk
            ? dir!.path
            : t('目录不存在或不是文件夹'),
    },
    {
      ok: !!dir?.gitBranch || checking,
      label: t('是 git 仓库'),
      hint: checking
        ? t('正在检查…')
        : dir?.gitBranch
          ? t('当前分支 {branch}', { branch: dir.gitBranch })
          : t('建议用 git 管理，方便查看和回退 Agent 的改动'),
      optional: true,
    },
    { ok: !!workflow, label: t('已指定工作流'), hint: workflow ? workflow.name : t('在项目或项目分类上指定') },
    {
      ok: !!workflow && isReady(workflowChecks(workflow, agents, clis)),
      label: t('工作流已就绪'),
      hint: !workflow
        ? t('先指定工作流')
        : isReady(workflowChecks(workflow, agents, clis))
          ? t('可以执行')
          : t('到工作流页面查看未通过的检查'),
    },
  ]
}
