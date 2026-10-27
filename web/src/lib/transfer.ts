import { AgentInput, WorkflowInput, type Agent, type Workflow } from '@shared/schema'
import { t } from '@shared/i18n'
import { includedAgents } from '@shared/agent-role'
import { isBuiltinAgent } from '@shared/builtin/core'
import {
  copyName,
  readShare,
  shareFileName,
  sharePackage,
  type ShareKind,
  type ShareMode,
  type SharePackage,
} from '@shared/agent-share'
import { api } from './api'

/**
 * 角色 / 工作流的导出导入（分享包格式见 shared/agent-share.ts）。
 * 导出成文件、导入落库都在前端做：格式校验和指纹都走同一份共享逻辑，服务端只负责最后的 schema 校验。
 *
 * 导入的取舍：
 * - 角色按名字复用，从不静默覆盖用户已有的角色；要覆盖时页面会先问（ImportConflict），内置那份只能另存为副本；
 * - 工作流用到的角色先落地、再按「包里的 id → 新 id」接回节点上的引用，角色设定不会缺；
 * - 角色之间的引入关系（includes）是本机 id，不随包走，导入后自己重新选。
 */

/** 工作流引用到的角色：主 Agent、成员、节点和步骤上的，加上它们引入的角色 */
export function workflowAgents(w: Workflow, agents: Agent[]) {
  const ids = new Set([w.mainAgentId, ...w.members.map((m) => m.agentId)])
  for (const f of w.flows)
    for (const n of f.nodes) {
      if (n.agentId) ids.add(n.agentId)
      for (const s of n.steps) if (s.agentId) ids.add(s.agentId)
    }
  for (const id of [...ids]) {
    const a = agents.find((x) => x.id === id)
    if (a) for (const x of includedAgents(a, agents)) ids.add(x.agent.id)
  }
  ids.delete('')
  return agents.filter((a) => ids.has(a.id))
}

/** 把包存成文件（浏览器下载）：文件名由包里那一项的名字决定 */
export function downloadShare(pkg: SharePackage) {
  const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = shareFileName(pkg)
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 导出一个角色 */
export function exportAgent(a: Agent) {
  downloadShare(sharePackage('agent', a, new Date().toISOString()))
}

/** 导出一个工作流：连同它用到的角色，换台机器导入后角色设定和节点上的引用都还在 */
export function exportWorkflow(w: Workflow, agents: Agent[]) {
  downloadShare(sharePackage('workflow', w, new Date().toISOString(), workflowAgents(w, agents)))
}

/** 撞上同名：页面拿它弹「覆盖 / 另存为副本」，不自己决定 */
export class ImportConflict extends Error {
  constructor(
    readonly name: string,
    readonly kind: 'agent' | 'workflow',
    /** 本机那份是内置的：只能另存为副本 */
    readonly builtin: boolean,
  ) {
    super(
      builtin
        ? t('本机已经有同名的内置{what}「{name}」：内置那份跟着面板同步，不能被导入覆盖，只能另存为副本', {
            what: kind === 'agent' ? t('角色') : t('工作流'),
            name,
          })
        : t('本机已经有同名的{what}「{name}」：覆盖它还是另存为副本？', {
            what: kind === 'agent' ? t('角色') : t('工作流'),
            name,
          }),
    )
  }
}

/** 导入一个包：mode 只在撞上同名时用（overwrite 覆盖本机那份 / copy 另存为副本） */
export interface ImportResult {
  kind: 'agent' | 'workflow'
  /** 落库后的 id：页面据此选中它 */
  id: string
  name: string
  /** 这次新建的角色（工作流的包会带上它用到的角色） */
  created: Agent[]
  /** 按名字复用的本机角色 */
  reused: Agent[]
  /** 旧版导出文件：没有指纹可校验 */
  legacy: boolean
}

function parseFile(text: string) {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(t('不是有效的 JSON 文件'))
  }
  const read = readShare(raw)
  if (!read.ok) throw new Error(read.info)
  return read
}

export async function importShare(text: string, mode?: ShareMode, expect?: ShareKind): Promise<ImportResult> {
  const read = parseFile(text)
  const pkg = read.pkg
  // 入口和包的类型要对上：在角色页选到工作流包时直接说清楚，不要真的建出一个工作流再跳不到
  if (expect && pkg.kind !== expect)
    throw new Error(
      expect === 'agent' ? t('这是工作流的分享包：换到工作流页去导入') : t('这是角色的分享包：换到角色页去导入'),
    )
  const local = await api.agents()
  const created: Agent[] = []
  const reused: Agent[] = []
  // 包里的角色先落地，建「原 id → 新 id」映射：工作流节点上的引用按它接回来
  const map = new Map<string, string>()
  for (const ref of pkg.agents) {
    const data = AgentInput.parse({ ...ref, includes: [] })
    const same = local.find((a) => a.name === data.name)
    if (same) {
      map.set(ref.id, same.id)
      reused.push(same)
      continue
    }
    const a = await api.createAgent(data)
    created.push(a)
    map.set(ref.id, a.id)
  }

  if (pkg.kind === 'agent') {
    const data = pkg.agent
    const same = local.find((a) => a.name === data.name)
    // 内置那份不能被覆盖：即使页面传了 overwrite 也拒绝，只能另存为副本
    if (same && (isBuiltinAgent(same) || mode !== 'overwrite'))
      throw new ImportConflict(same.name, 'agent', isBuiltinAgent(same))
    const item =
      same && mode === 'overwrite'
        ? await api.updateAgent(same.id, { ...data, name: same.name })
        : await api.createAgent({
            ...data,
            name: same
              ? copyName(
                  data.name,
                  local.map((a) => a.name),
                )
              : data.name,
          })
    return { kind: 'agent', id: item.id, name: item.name, created: [], reused: [], legacy: !!read.legacy }
  }

  const w = WorkflowInput.parse(pkg.workflow)
  const re = (id: string) => (id ? (map.get(id) ?? '') : '')
  const input = WorkflowInput.parse({
    ...w,
    mainAgentId: re(w.mainAgentId),
    // 旧版的「团队」成员不随包走（分享包里 agentId 已剥掉），这里映射后必然是空：
    // 现在节点上选 Agent，members 只为读旧数据保留，不影响节点执行
    members: w.members.map((m) => ({ ...m, agentId: re(m.agentId) })).filter((m) => m.agentId),
    flows: w.flows.map((f) => ({
      ...f,
      nodes: f.nodes.map((n) => ({
        ...n,
        agentId: re(n.agentId),
        steps: n.steps.map((s) => ({ ...s, agentId: re(s.agentId) })),
      })),
    })),
  })
  const same = (await api.workflows()).find((x) => x.name === input.name)
  const builtin = !!same?.origin?.startsWith('builtin:')
  if (same && (builtin || mode !== 'overwrite')) throw new ImportConflict(same.name, 'workflow', builtin)
  const item =
    same && mode === 'overwrite'
      ? await api.updateWorkflow(same.id, { ...input, name: same.name })
      : await api.createWorkflow({
          ...input,
          name: same
            ? copyName(
                input.name,
                (await api.workflows()).map((x) => x.name),
              )
            : input.name,
        })
  return { kind: 'workflow', id: item.id, name: item.name, created, reused, legacy: !!read.legacy }
}
