import type { BundledSkill, LibraryItem, McpEntry } from '@shared/library'
import type { ProjectMcpDetected } from '@shared/projects/mcp'
import type { ProjectSkill } from '@shared/projects/skills'
import { pluginOnFor, type ProjectCapabilities } from '@shared/projects/capabilities'
import type { PluginRow } from '@/plugins/registry'
import { CLIS } from '@shared/clis'
import { t } from '@shared/i18n'

/**
 * 项目「能力」页和「技能与 MCP」页列的条目（设计稿：Agent侧栏与项目管理重设计 B3、6.3）：
 * 把项目目录里的技能和 MCP 配置、全局库里的技能和 MCP 拼成一份列表，标清来源和生效方式。
 *
 * 生效方式（scope）：
 * - always：面板自带，始终交给 Agent，不能关；
 * - global：全局库里的条目，对所有项目生效，项目里不出现开关（用户定：全局生效的在项目里没有开关）；
 * - project：全局库里标了按项目的，项目「能力」里打开了才带上，开关写 capabilities.mcp / skills；
 * - own：项目目录里的，跟着仓库走，面板里不能关（关要去改项目文件）。
 */
export type CapScope = 'always' | 'global' | 'project' | 'own'

export interface CapItem {
  key: string
  kind: 'skill' | 'mcp'
  name: string
  description: string
  scope: CapScope
  /** 来源：项目里的文件或目录，或「面板自带」「全局 MCP 库」这类说法 */
  where: string
  /** 来源下面一行：哪些 Agent 能读到、识别到没导入 */
  whereNote: string
  /** 项目里识别到、还没导入成面板管理的 MCP 配置 */
  importable?: boolean
  /**
   * 已经算好的开没开：面板插件带的 MCP 按插件开关（capabilities.plugins）算，不在 capabilities.mcp 的名单里，
   * 不能拿显示名去名单里找（以前这样找，UE 插件明明在项目里打开了也显示「没打开」）
   */
  on?: boolean
  /**
   * 插件 MCP 实际在哪些对话里挂（插件能力目录里的 attach，例如「只在 UI 设计页的 AI 对话里」）：
   * 有它的全局插件不再只标「全局」，标「按场景」并写出这一句（用户 2026-11-17：UI 设计的 MCP 只在 UI 设计里生效）
   */
  when?: string
}

const cliNames = (ids: string[]) =>
  ids
    .map((id) => CLIS.find((c) => c.id === id)?.name ?? id)
    .filter(Boolean)
    .join(t('、'))

/** 项目自己的：项目目录里的技能、识别到的 MCP 配置 */
export function ownItems(skills: ProjectSkill[], detected: ProjectMcpDetected[]): CapItem[] {
  return [
    ...skills.map((s): CapItem => ({
      key: `skill:own:${s.dir}`,
      kind: 'skill',
      name: s.name,
      description: s.description,
      scope: 'own',
      where: s.source,
      whereNote: s.clis.length ? t('{clis} 能读到', { clis: cliNames(s.clis) }) : '',
    })),
    // 已经导入面板的会在「从全局继承」里列出来，这里只列还没导入的，免得同一个工具列两遍
    ...detected
      .filter((d) => d.status === 'new')
      .map((d): CapItem => ({
        key: `mcp:own:${d.file}:${d.name}`,
        kind: 'mcp',
        name: d.name,
        description: d.source,
        scope: 'own',
        where: d.file,
        whereNote: t('识别到，未导入'),
        importable: true,
      })),
  ]
}

/** 从全局来的：面板管理的 MCP 工具、面板自带和插件带的技能、用户目录里的技能 */
export function globalItems(input: {
  mcp: McpEntry[]
  bundled: BundledSkill[]
  library: LibraryItem[]
  /** 插件名（插件带的技能标「来自插件 xx」） */
  pluginName: (id: string) => string
}): CapItem[] {
  const out: CapItem[] = input.mcp.map((m) => ({
    key: `mcp:lib:${m.name}`,
    kind: 'mcp',
    name: m.name,
    description: m.transport === 'http' ? m.url : [m.command, ...m.args].join(' '),
    scope: m.activation === 'project' ? 'project' : 'global',
    where: t('全局 MCP 库'),
    whereNote: m.clis.length ? cliNames(m.clis) : t('还没写进任何 Agent'),
  }))
  const bundledNames = new Set(input.bundled.map((b) => b.name))
  for (const b of input.bundled)
    out.push({
      key: `skill:bundled:${b.name}`,
      kind: 'skill',
      name: b.name,
      description: b.description,
      scope: b.activation === 'project' ? 'project' : 'global',
      where: b.plugin ? t('来自插件 {name}', { name: input.pluginName(b.plugin) }) : t('面板自带'),
      whereNote: '',
    })
  // 用户目录里的技能：几个 Agent 共用一个目录时同名的会列好几遍，按名字合成一条；面板自带的已经列过
  const byName = new Map<string, LibraryItem[]>()
  for (const x of input.library)
    if (x.kind === 'skill' && !bundledNames.has(x.name)) byName.set(x.name, [...(byName.get(x.name) ?? []), x])
  for (const [name, xs] of byName)
    out.push({
      key: `skill:lib:${name}`,
      kind: 'skill',
      name,
      description: xs[0].description,
      scope: xs.some((x) => x.activation === 'project') ? 'project' : 'global',
      where: t('用户目录'),
      whereNote: cliNames([...new Set(xs.map((x) => x.cli))]),
    })
  return out
}

/**
 * 开着的插件带的 MCP 里，这个项目实际会挂上的（和服务端每轮挂工具同一条规则 pluginOnFor）：
 * 全局生效的插件标「全局」，按项目生效的标「本项目已打开」。开没开直接算好放进 on，不去 capabilities.mcp 里按名字找
 */
export function pluginMcpItems(
  rows: PluginRow[],
  project: { capabilities?: Partial<ProjectCapabilities> } | undefined,
  /** 插件 id → 挂在哪些对话（能力目录的 attach）；读不到时为空，照旧只标全局 / 按项目 */
  attachOf: (id: string) => string = () => '',
): CapItem[] {
  return rows
    .filter((r) => r.enabled && r.manifest.mcpServers.length)
    .filter((r) => pluginOnFor(project, r.manifest.id, r.manifest.activation))
    .map((r) => ({
      key: `mcp:plugin:${r.manifest.id}`,
      kind: 'mcp',
      name: t('{name}（插件）', { name: t(r.manifest.name) }),
      description: r.manifest.description,
      scope: r.manifest.activation === 'project' ? 'project' : 'global',
      where: t('面板插件'),
      whereNote: attachOf(r.manifest.id),
      on: true,
      ...(attachOf(r.manifest.id) && { when: attachOf(r.manifest.id) }),
    }))
}

/** 按项目生效的条目在这个项目里打开了没有 */
export const itemOn = (item: CapItem, caps: Partial<ProjectCapabilities> | undefined) =>
  item.on ?? (item.scope !== 'project' || !!(item.kind === 'mcp' ? caps?.mcp : caps?.skills)?.includes(item.name))

/** 这个项目实际会带上的：始终、全局、项目自己的都算，按项目的看开关 */
export const activeItems = (items: CapItem[], caps: Partial<ProjectCapabilities> | undefined) =>
  items.filter((x) => itemOn(x, caps))
