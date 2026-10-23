import { CLIS } from '@shared/clis'
import type {
  BundledSkill,
  LibraryCli,
  LibraryFile,
  LibraryItem,
  McpEntry,
  McpOverview,
  McpServer,
} from '@shared/library'
import { frontField } from '@shared/library'
import { ALL_AGENTS } from '@shared/commands'
import type { SlashCommand } from '@shared/schema'

/**
 * 在线演示里的 Skills / 命令库和 MCP 工具：没有本机的 CLI 和配置文件，数据放在内存里
 */
type Kind = 'skill' | 'command'
interface Item extends LibraryItem {
  content: string
  files: string[]
}

const skill = (cli: string, name: string, description: string, body: string, files: string[] = []): Item => ({
  cli,
  kind: 'skill',
  name,
  description,
  path: `~/.${cli}/skills/${name}/SKILL.md`,
  content: `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
  files,
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
  files: [],
})

const items: Item[] = [
  skill('claude', 'commit-message', '按团队约定写提交说明', '先看 git diff，再按「类型：标题」的格式写提交说明。', [
    'examples.md',
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
    clis: ['claude', 'gemini'],
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
const overview = (active: string[]): McpOverview => ({
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
      return { name, category, description: frontField(text, 'description'), files: 0, status }
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
    if (!id) return overview(active)
    const name = decodeURIComponent(id)
    const at = servers.findIndex((s) => s.name === name)
    if (at >= 0) servers.splice(at, 1)
    if (method === 'PUT') servers.push({ ...(body.server as McpServer), name, clis: body.clis ?? [] })
    return overview(active)
  }
  // 自带 Skill：内容取仓库 skills/ 下的 SKILL.md，装没装记在内存里
  if (id === 'bundled') {
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
  const kind = (query.get('kind') ?? body.kind) as Kind
  const cli = query.get('cli') ?? body.cli
  const name = query.get('name') ?? body.name
  const find = (c: string, n: string) => items.findIndex((x) => x.kind === kind && x.cli === c && x.name === n)
  if (!id)
    return {
      clis: libClis(active),
      items: items
        .filter((x) => x.kind === kind && (active.includes(x.cli) || x.cli === ALL_AGENTS))
        .map(({ content: _c, files: _f, ...i }) => i),
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
    return { content: items[at].content, files: items[at].files } satisfies LibraryFile
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
    files: at >= 0 ? items[at].files : [],
  }
  if (at >= 0) items[at] = next
  else items.push(next)
  return { ok: true }
}
