import { CLIS } from '@shared/clis'
import type {
  BundledSkill,
  LibraryCli,
  LibraryFile,
  LibraryEntry,
  LibraryItem,
  McpEntry,
  McpOverview,
  McpServer,
} from '@shared/library'
import { frontField, treeFromPaths } from '@shared/library'
import { ALL_AGENTS } from '@shared/commands'
import type { SlashCommand } from '@shared/schema'

/**
 * 在线演示里的 Skills / 命令库和 MCP 工具：没有本机的 CLI 和配置文件，数据放在内存里
 */
type Kind = 'skill' | 'command'
interface Item extends LibraryItem {
  content: string
  /** 主文件以外的文件：路径 → 内容（目录不在这里，按路径推出来） */
  extra: Map<string, string>
  dirs: string[]
}

/** 演示里按路径算文件树：目录在前、同级按名字排，和后端一致 */
function treeOf(item: Item): { entries: LibraryEntry[]; truncated?: boolean } {
  const dirs = new Set(item.dirs)
  for (const p of item.extra.keys()) {
    const parts = p.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }
  const out: LibraryEntry[] = [...dirs].map((path) => ({ path, type: 'dir' as const }))
  for (const [path, content] of item.extra)
    out.push({ path, type: 'file', size: new TextEncoder().encode(content).length })
  const entries = out.sort((a, b) => {
    const ad = a.path.split('/')
    const bd = b.path.split('/')
    // 先按层级逐个比：目录排在同级文件前面
    for (let i = 0; i < Math.min(ad.length, bd.length); i++) {
      if (ad[i] === bd[i]) continue
      const aDir = i < ad.length - 1 || a.type === 'dir'
      const bDir = i < bd.length - 1 || b.type === 'dir'
      if (aDir !== bDir) return aDir ? -1 : 1
      return ad[i].localeCompare(bd[i])
    }
    return a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'dir' ? -1 : 1
  })
  // 和真接口一样：超上限时带上 truncated（演示数据远到不了，这里保留字段形状）
  return { entries }
}

const extraOf = (paths: string[]) =>
  new Map(paths.map((p) => [p, p.endsWith('.md') ? `# ${p}\n\n演示用的附加文件。\n` : `演示用的附加文件 ${p}\n`]))

const skill = (cli: string, name: string, description: string, body: string, files: string[] = []): Item => ({
  cli,
  kind: 'skill',
  name,
  description,
  path: `~/.${cli}/skills/${name}/SKILL.md`,
  content: `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
  extra: extraOf(files),
  // 演示数据里放一个空目录：文件树要能显示空目录，不只有文件的目录
  dirs: files.some((f) => f.startsWith('references/')) ? ['references', 'references/templates'] : [],
})
/** 命令文件的位置：「所有 Agent」的在面板数据目录里 */
const commandPath = (cli: string, name: string) =>
  cli === ALL_AGENTS ? `~/.agent-panel/commands/${name}.md` : `~/.${cli}/commands/${name}.md`

const command = (cli: string, name: string, description: string, body: string): Item => ({
  cli,
  kind: 'command',
  name,
  description,
  path: commandPath(cli, name),
  content: `---\ndescription: ${description}\n---\n${body}\n`,
  extra: new Map(),
  dirs: [],
})

const items: Item[] = [
  skill('claude', 'commit-message', '按团队约定写提交说明', '先看 git diff，再按「类型：标题」的格式写提交说明。', [
    'examples.md',
    'references/pitfalls.md',
  ]),
  skill('claude', 'code-review', '审查改动，指出风险和遗漏的测试', '逐个文件看改动，先说结论，再列问题。'),
  skill('codex', 'commit-message', '按团队约定写提交说明', '先看 git diff，再按「类型：标题」的格式写提交说明。'),
  command(
    'claude',
    'commit',
    '看一下改动，按约定写提交说明并提交',
    '看一下当前的改动，按项目的约定写提交说明并提交。$ARGUMENTS',
  ),
  command('claude', 'fix-issue', '按 issue 编号修复问题', '读 issue $1，找到原因并修复，补上测试。'),
  command('codex', 'explain', '解释一段代码的作用', '解释下面这段代码做了什么、为什么这样写：$ARGUMENTS'),
  command(
    ALL_AGENTS,
    'changelog',
    '按最近的提交整理一段给用户看的更新说明',
    '看最近的提交（$ARGUMENTS 为空时从上一个标签开始），整理成「新功能 / 改进 / 修复」三组更新说明。',
  ),
]

/** 演示的「/」菜单里「所有 Agent」的命令：选哪个 CLI 都有 */
export const demoPanelCommands = (): SlashCommand[] =>
  items
    .filter((x) => x.kind === 'command' && x.cli === ALL_AGENTS)
    .map((x) => ({ name: x.name, description: x.description, kind: 'command', source: '所有 Agent' }))

const servers: McpEntry[] = [
  {
    name: 'github',
    transport: 'http',
    command: '',
    args: [],
    env: {},
    url: 'https://api.githubcopilot.com/mcp/',
    headers: { Authorization: 'Bearer ghp_demo' },
    clis: ['claude', 'codex'],
  },
  {
    name: 'filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '~/projects'],
    env: {},
    url: '',
    headers: {},
    clis: ['claude', 'pi'],
  },
]

const libClis = (active: string[]): LibraryCli[] => [
  { id: ALL_AGENTS, name: '所有 Agent', skillDir: '', commandDir: '~/.agent-panel/commands', commandFormat: 'md' },
  ...CLIS.filter((c) => active.includes(c.id)).map((c) => ({
    id: c.id,
    name: c.name,
    skillDir: `~/.${c.id}/skills`,
    commandDir: `~/.${c.id}/commands`,
    commandFormat: c.commands.format,
  })),
]

const mcpClis = (active: string[]) =>
  CLIS.filter((c) => c.mcpStore && active.includes(c.id)).map((c) => ({
    id: c.id,
    name: c.name,
    file: c.mcpStore!.file,
  }))

/** 项目设置里的 MCP 分节在演示版也用这同一份数据：正式版里两边本来就是同一份配置 */
export const demoMcpClis = mcpClis
export const demoMcpServers = servers
export const demoMcpOverview = (active: string[]): McpOverview => ({
  clis: mcpClis(active),
  // 停用的 CLI 不在「装在哪些 CLI」里显示
  servers: servers
    .map((s) => ({ ...s, clis: s.clis.filter((id) => active.includes(id)) }))
    .sort((a, b) => a.name.localeCompare(b.name)),
})

const BUNDLED = import.meta.glob('../../../skills/*/*/SKILL.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
/**
 * 自带技能的全部文件：详情页要列出它们、点开要看内容。
 * 不限扩展名——真后端的 treeOf 也按文件系统实际内容列，演示数据跟着同一个口径走。
 * 注意 ?raw 会把文件按文本读进来：skills/ 下只该放文本，别放 png、字体这类二进制。
 */
const BUNDLED_FILES = import.meta.glob('../../../skills/*/*/**/*', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>
const bundledOf = (name: string) => {
  const hit = Object.entries(BUNDLED).find(([file]) => file.split('/skills/')[1].split('/')[1] === name)
  if (!hit) return null
  const prefix = hit[0].slice(0, -'SKILL.md'.length)
  // 相对技能目录的路径 → 内容
  const files = new Map<string, string>()
  for (const [file, text] of Object.entries(BUNDLED_FILES))
    if (file.startsWith(prefix)) files.set(file.slice(prefix.length), text)
  return { category: hit[0].split('/skills/')[1].split('/')[0], files }
}
const installedBundled = new Map<string, BundledSkill['status'][string]>([
  // 预置两条和自带不一样的，演示版里才看得到「更新全部」的效果
  ['brainstorming', 'changed'],
  ['blender', 'changed'],
])
function bundledList(): BundledSkill[] {
  return Object.entries(BUNDLED)
    .map(([file, text]) => {
      const [category, name] = file.split('/skills/')[1].split('/')
      const status: BundledSkill['status'] = { shared: installedBundled.get(name) ?? 'missing' }
      // 文件树和真接口同一份算法（shared 的 treeFromPaths），详情页不用为演示版分叉
      const all = [...(bundledOf(name)?.files ?? new Map<string, string>())]
        .filter(([rel]) => rel !== 'SKILL.md')
        .map(([rel, body]) => ({ path: rel, size: new TextEncoder().encode(body).length }))
      const tree = treeFromPaths(all)
      return {
        name,
        category,
        description: frontField(text, 'description'),
        files: tree.entries.filter((e) => e.type === 'file').length,
        tree,
        status,
      }
    })
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
}

export function demoLibrary(
  method: string,
  seg: string[],
  query: URLSearchParams,
  body: any,
  active: string[],
): unknown {
  const [res, id] = seg
  if (res === 'mcp-tools') {
    if (id === 'test') {
      const sv = body as McpServer
      return {
        ok: true,
        server: sv.name,
        tools: [
          { name: 'read_file', description: '读一个文件的内容' },
          { name: 'list_directory', description: '列出目录下的文件' },
          { name: 'search_files', description: '按名字搜索文件' },
        ],
      }
    }
    if (!id) return demoMcpOverview(active)
    const name = decodeURIComponent(id)
    const at = servers.findIndex((s) => s.name === name)
    if (at >= 0) servers.splice(at, 1)
    if (method === 'PUT') servers.push({ ...(body.server as McpServer), name, clis: body.clis ?? [] })
    return demoMcpOverview(active)
  }
  // 自带 Skill：内容取仓库 skills/ 下的 SKILL.md，装没装记在内存里
  if (id === 'bundled') {
    // 自带 Skill 的文件内容（只读）：path 空表示 SKILL.md
    if (seg[2] === 'entry') {
      const name = query.get('name') ?? ''
      const hit = bundledOf(name)
      if (!hit) throw new Error(`没有自带的 Skill「${name}」`)
      const rel = query.get('path') || 'SKILL.md'
      const text = hit.files.get(rel)
      if (text === undefined) throw new Error('没有这个文件')
      return { path: rel, exists: true, content: text, size: new TextEncoder().encode(text).length }
    }
    if (seg[2] === 'install') {
      const done: string[] = []
      const skipped: string[] = []
      for (const n of body.names as string[]) {
        const now = installedBundled.get(n) ?? 'missing'
        // 和真接口一样：已经一样的跳过，改过的只有 overwrite 时才换回自带版本
        if (now === 'same' || (now === 'changed' && !body.overwrite)) skipped.push(n)
        else {
          installedBundled.set(n, 'same')
          done.push(n)
        }
      }
      return { done, skipped }
    }
    return { items: bundledList() }
  }
  // library
  // 附加文件：和真接口同一套路径和错误文案，详情页的读写不用为演示版分叉
  if (id === 'entry') {
    const kind2 = (query.get('kind') ?? body.kind) as Kind
    const at2 = items.findIndex(
      (x) =>
        x.kind === kind2 && x.cli === (query.get('cli') ?? body.cli) && x.name === (query.get('name') ?? body.name),
    )
    if (at2 < 0) throw new Error('没有这一项')
    if (kind2 !== 'skill') throw new Error('只有 Skill 能管理文件')
    const it = items[at2]
    const action = seg[2]
    if (action === 'rename') {
      const { from, to } = body as { from: string; to: string }
      if (it.extra.has(from)) {
        it.extra.set(to, it.extra.get(from) ?? '')
        it.extra.delete(from)
      } else if (it.dirs.includes(from)) {
        const move = (p: string) => (p === from || p.startsWith(`${from}/`) ? to + p.slice(from.length) : p)
        it.dirs = it.dirs.map(move)
        it.extra = new Map([...it.extra].map(([p, c]) => [move(p), c]))
      } else throw new Error('没有这个文件')
      return { ok: true }
    }
    if (action === 'mkdir') {
      const path = String((body as { path?: string }).path ?? '')
      if (!it.dirs.includes(path)) it.dirs.push(path)
      return { ok: true }
    }
    const path = query.get('path') ?? (body as { path?: string }).path ?? ''
    if (method === 'GET') {
      if (!it.extra.has(path)) throw new Error('没有这个文件')
      const content = it.extra.get(path) ?? ''
      return { path, content, size: new TextEncoder().encode(content).length, binary: false }
    }
    if (method === 'DELETE') {
      if (it.extra.delete(path)) return { ok: true }
      if (it.dirs.includes(path)) {
        it.dirs = it.dirs.filter((d) => d !== path && !d.startsWith(`${path}/`))
        for (const p of [...it.extra.keys()]) if (p.startsWith(`${path}/`)) it.extra.delete(p)
        return { ok: true }
      }
      throw new Error('没有这个文件')
    }
    it.extra.set(path, String((body as { content?: string }).content ?? ''))
    return { ok: true }
  }
  const kind = (query.get('kind') ?? body.kind) as Kind
  const cli = query.get('cli') ?? body.cli
  const name = query.get('name') ?? body.name
  const find = (c: string, n: string) => items.findIndex((x) => x.kind === kind && x.cli === c && x.name === n)
  if (!id)
    return {
      clis: libClis(active),
      items: items
        .filter((x) => x.kind === kind && (active.includes(x.cli) || x.cli === ALL_AGENTS))
        .map(({ content: _c, extra: _e, dirs: _d, ...i }) => i),
    }
  if (id === 'copy') {
    const src = items[find(cli, name)]
    const done: string[] = []
    const skipped: string[] = []
    for (const to of body.to as string[]) {
      if (to === cli) continue
      const at = find(to, name)
      if (at >= 0 && !body.overwrite) skipped.push(to)
      else {
        if (at >= 0) items.splice(at, 1)
        items.push({
          ...src,
          cli: to,
          path: kind === 'command' ? commandPath(to, name) : src.path.replace(`.${cli}/`, `.${to}/`),
        })
        done.push(to)
      }
    }
    return { done, skipped }
  }
  const at = find(cli, name)
  if (method === 'GET') {
    if (at < 0) throw new Error('没有这一项')
    const it = items[at]
    return {
      content: it.content,
      files: [...it.extra.keys()].sort(),
      tree: kind === 'skill' ? treeOf(it) : undefined,
    } satisfies LibraryFile
  }
  if (method === 'DELETE') {
    if (at >= 0) items.splice(at, 1)
    return { ok: true }
  }
  // PUT
  if (at >= 0 && body.create) throw new Error(`「${name}」已经有了`)
  const desc = /^description:\s*(.*)$/m.exec(body.content)?.[1] ?? ''
  const next: Item = {
    cli,
    kind,
    name,
    description: desc.replace(/^["']|["']$/g, ''),
    path: kind === 'skill' ? `~/.${cli}/skills/${name}/SKILL.md` : commandPath(cli, name),
    content: body.content,
    extra: at >= 0 ? items[at].extra : new Map(),
    dirs: at >= 0 ? items[at].dirs : [],
  }
  if (at >= 0) items[at] = next
  else items.push(next)
  return { ok: true }
}
