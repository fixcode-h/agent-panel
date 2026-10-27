/**
 * 角色 / 工作流的分享包（导出导入 JSON）：包里是内容本身加一个内容指纹，
 * 用来判断「这份包和本地的是不是同一版」，以及拦下被手改过的包。
 *
 * 边界：
 * 1. 包不带本机才有的东西（分类 id、标签 id、追加的 CLI 参数、来源标记）：导出时剥掉，
 *    导入时再剥一次——手改的包也不能把 origin 写成内置来源，绕开内置的同步逻辑；
 * 2. 指纹按剥好的内容算（导出和校验用同一套剥法），不含导出时间和文件名，同一份内容永远是同一个值；
 * 3. 内置角色 / 工作流能导出，但导入时不许覆盖内置那份（由 shared/builtin 的同步逻辑管）；
 * 4. 工作流的包可以带上它用到的角色（`agents`），导入时按名字复用或新建，角色设定不会缺；
 *    只有工作流本身同名时才问「覆盖还是另存为副本」，角色从不静默覆盖。
 */
import { z } from 'zod'
import { AgentInput, WorkflowFields, type Agent, type Workflow } from './schema.ts'
import { contentHash } from './hash.ts'
import { t } from './i18n.ts'

/** 包的类型标记：读文件时先看它，别的 JSON 直接拒 */
export const SHARE_FORMAT = 'agent-panel/share'
/** 分享包格式版本：以后改结构时靠它判断能不能读 */
export const SHARE_VERSION = 1
/** 旧版工作流导出（web/src/lib/transfer.ts 早期格式）：还能读，但没有指纹 */
export const LEGACY_SHARE_FORMAT = 'agent-panel/workflow'

/**
 * 分享包里不带的本机字段和复位值。分类、标签、引入关系都是本机 id，跨机器没有意义；
 * extraArgs 可能写着本机路径；origin / upgrades 是内置同步用的，跟着包走会让导入的副本被当成内置。
 * 只有这一份清单：剥本机字段、判断带没带，都按它来。
 */
const AGENT_LOCAL_RESET = {
  categoryId: '',
  tags: [],
  includes: [],
  extraArgs: [],
  origin: '',
  upgrades: undefined,
} satisfies Partial<AgentInput>

/** 分享包里不带的本机字段名（单测和文档引用它，避免另抄一份字段清单） */
export const AGENT_LOCAL_FIELDS = Object.keys(AGENT_LOCAL_RESET)

/** 剥掉本机字段后的角色内容（导出和导入都走它） */
export const scrubAgent = (a: AgentInput): AgentInput => AgentInput.parse({ ...a, ...AGENT_LOCAL_RESET })

type WorkflowShare = z.infer<typeof WorkflowFields>

const nodeOut = (n: WorkflowShare['flows'][number]['nodes'][number]) => ({
  ...n,
  agentId: '',
  steps: n.steps.map((s) => ({ ...s, agentId: '' })),
})

/**
 * 剥掉本机字段后的工作流内容：分类、标签、来源、内置指纹、主 Agent、节点上选的 Agent 都清空
 * （它们在本机是 id，导入后按包里带的角色重新接上）。流程之间的引用、节点 id、坐标保留，导入后画布形状不变。
 */
export function scrubWorkflow(w: WorkflowShare): WorkflowShare {
  const x = WorkflowFields.parse(w)
  return {
    ...x,
    categoryId: '',
    tags: [],
    origin: undefined,
    builtinHash: undefined,
    mainAgentId: '',
    // 旧版的「团队」字段还在数据里，agentId 是本机 id；现在节点上选 Agent，这个列表只用来读旧数据
    members: x.members.map((m) => ({ ...m, agentId: '' })),
    flows: x.flows.map((f) => ({ ...f, nodes: f.nodes.map(nodeOut) })),
  }
}

/** 包里带的角色：剥好的内容加上原来的 id，导入时靠它把工作流节点上的角色接回来 */
export const ShareAgentRef = AgentInput.extend({ id: z.string() })
export type ShareAgentRef = z.infer<typeof ShareAgentRef>

/** 两种包共用的头：格式、版本、指纹、导出时间和带的角色 */
const ShareBase = {
  format: z.literal(SHARE_FORMAT),
  version: z.number().int(),
  fingerprint: z.string().min(1),
  /** 导出时间：只作参考，不参与指纹 */
  exportedAt: z.string().default(''),
  /** 工作流用到的角色（单个角色包里为空）：带原来的 id 只为把节点上的引用接回来，不参与指纹 */
  agents: z.array(ShareAgentRef).default([]),
}

/** 角色包 / 工作流包：kind 区分，agent / workflow 里是剥好的内容 */
export const SharePackage = z.discriminatedUnion('kind', [
  z.object({ ...ShareBase, kind: z.literal('agent'), agent: AgentInput }),
  z.object({ ...ShareBase, kind: z.literal('workflow'), workflow: WorkflowFields }),
])
export type SharePackage = z.infer<typeof SharePackage>
export type ShareKind = SharePackage['kind']

/** 导入时同名怎么处理：覆盖本机那份，或者另存为副本 */
export type ShareMode = 'overwrite' | 'copy'

type FingerprintInput =
  | Pick<Extract<SharePackage, { kind: 'agent' }>, 'kind' | 'agent' | 'agents'>
  | Pick<Extract<SharePackage, { kind: 'workflow' }>, 'kind' | 'workflow' | 'agents'>

/** 指纹算哪些东西：类别、版本、剥好的内容和带的角色；导出时间、文件名不算 */
export function shareFingerprint(pkg: FingerprintInput) {
  const agents = pkg.agents.map(scrubAgent)
  return pkg.kind === 'agent'
    ? contentHash({ kind: 'agent', version: SHARE_VERSION, data: scrubAgent(pkg.agent), agents })
    : contentHash({ kind: 'workflow', version: SHARE_VERSION, data: scrubWorkflow(pkg.workflow), agents })
}

/** 导出用到的角色：按 id 找，剥掉本机字段，保留原 id 给导入时接引用 */
export function shareAgents(list: Agent[]) {
  return list.map((a) => ({ ...scrubAgent(a), id: a.id }))
}

/** 导出：剥掉本机字段再算指纹，得到可以直接写成 JSON 文件的包 */
export function sharePackage(
  kind: 'agent',
  data: Agent,
  at: string,
  used?: Agent[],
): Extract<SharePackage, { kind: 'agent' }>
export function sharePackage(
  kind: 'workflow',
  data: Workflow,
  at: string,
  used?: Agent[],
): Extract<SharePackage, { kind: 'workflow' }>
export function sharePackage(kind: ShareKind, data: Agent | Workflow, at: string, used: Agent[] = []): SharePackage {
  const head = {
    format: SHARE_FORMAT as typeof SHARE_FORMAT,
    version: SHARE_VERSION,
    exportedAt: at,
    agents: shareAgents(used),
  }
  if (kind === 'agent') {
    const body = { ...head, kind: 'agent' as const, agent: scrubAgent(data as Agent) }
    return { ...body, fingerprint: shareFingerprint(body) }
  }
  const body = { ...head, kind: 'workflow' as const, workflow: scrubWorkflow(data as Workflow) }
  return { ...body, fingerprint: shareFingerprint(body) }
}

/** 包里的角色名或工作流名 */
export const shareName = (pkg: SharePackage) => (pkg.kind === 'agent' ? pkg.agent.name : pkg.workflow.name)

/**
 * 读一个包：格式、版本、指纹三关都过才算能导入。
 * 指纹按「剥好的内容」重算：手改过名字、指令或者多塞一个字段，都会和包里写的对不上。
 * 旧版工作流导出（没有指纹）照旧能读，返回值里标 legacy，界面提示这份文件没经过指纹校验。
 */
export function readShare(
  raw: unknown,
): { ok: true; pkg: SharePackage; legacy?: boolean } | { ok: false; info: string } {
  // 旧格式：{ format: 'agent-panel/workflow', version: 1, workflow, agents }
  if (raw && typeof raw === 'object' && (raw as Record<string, unknown>).format === LEGACY_SHARE_FORMAT)
    return readLegacy(raw as Record<string, unknown>)
  const p = SharePackage.safeParse(raw)
  if (!p.success)
    return { ok: false, info: t('这不是角色或工作流的分享包：{error}', { error: z.prettifyError(p.error) }) }
  const pkg = p.data
  if (pkg.version !== SHARE_VERSION)
    return {
      ok: false,
      info: t('分享包的格式版本是 {v}，这个面板只认 {mine}：换一个版本的包，或者用导出方升级后的面板', {
        v: pkg.version,
        mine: SHARE_VERSION,
      }),
    }
  // 角色包不带「用到的角色」：那是工作流包的配套字段，带着说明结构被改过（或者从别的格式转错了）
  if (pkg.kind === 'agent' && pkg.agents.length)
    return { ok: false, info: t('角色包里不该带其它角色（那是工作流包的字段）：文件结构被改过，不导入') }
  const actual = shareFingerprint(pkg)
  if (actual !== pkg.fingerprint)
    return {
      ok: false,
      info: t('指纹和内容对不上（包里写的是 {fp}，按内容算是 {actual}）：文件被手改过，不导入', {
        fp: pkg.fingerprint,
        actual,
      }),
    }
  // 读出来的包一律是可以直接落库的形态：指纹只算剥好的内容，所以手改本机字段也能过校验，
  // 不能指望每个调用方记得再剥一次——在唯一的读入口把这一步做掉
  return { ok: true, pkg: cleanShare(pkg) }
}

/** 导入落库前的形态：本机字段复位，包里带的角色只留原 id 用来把节点上的引用接回去 */
function cleanShare(pkg: SharePackage): SharePackage {
  if (pkg.kind === 'agent') return { ...pkg, agent: scrubAgent(pkg.agent) }
  return {
    ...pkg,
    workflow: scrubWorkflow(pkg.workflow),
    agents: pkg.agents.map((a) => ({ ...scrubAgent(a), id: a.id })),
  }
}

/** 旧版导出的工作流文件：结构按新格式转一次，没有指纹可校验 */
function readLegacy(
  raw: Record<string, unknown>,
): { ok: true; pkg: SharePackage; legacy: true } | { ok: false; info: string } {
  const w = WorkflowFields.safeParse(raw.workflow)
  if (!w.success)
    return { ok: false, info: t('旧版导出的工作流文件格式不对：{error}', { error: z.prettifyError(w.error) }) }
  const agents = z.array(ShareAgentRef).safeParse(raw.agents ?? [])
  const pkg = {
    format: SHARE_FORMAT,
    kind: 'workflow',
    version: SHARE_VERSION,
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
    workflow: scrubWorkflow(w.data),
    agents: agents.success ? agents.data.map((a) => ({ ...scrubAgent(a), id: a.id })) : [],
  } as SharePackage
  return { ok: true, pkg: { ...pkg, fingerprint: shareFingerprint(pkg) }, legacy: true }
}

/** 同名时「另存为副本」的名字：副本、副本 2、副本 3…直到不和已有的重名 */
export function copyName(name: string, taken: string[]) {
  const used = new Set(taken)
  let candidate = t('{name}（副本）', { name })
  for (let i = 2; used.has(candidate) && i < 100; i++) candidate = t('{name}（副本 {n}）', { name, n: i })
  return candidate
}

/** 下载用的文件名：去掉文件名里不能用的字符，带 kind 后缀区分角色和工作流 */
export function shareFileName(pkg: SharePackage) {
  const base =
    shareName(pkg)
      .replace(/[\\/:*?"<>|\s]+/g, '-')
      .slice(0, 60) || 'share'
  return `${base}.${pkg.kind}.json`
}
