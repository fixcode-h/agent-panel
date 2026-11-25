/**
 * 演示：自建工具（ADR 0082）。没有本机磁盘和 shell：列表、保存（版本 +1、历史）、复制、删除、参数校验和命令展开都用
 * shared 里的同一份逻辑；「运行」不真的执行，按展开后的命令给一段写好的输出，看得到结果长什么样
 */
import { checkArgs, commandTemplate, draftProblems, expandCommand } from '@shared/custom-tools/expand'
import { CustomTool, nextVersion, ToolScope, type ToolEntry } from '@shared/custom-tools/schema'
import { runText } from '@shared/custom-tools/text'
import { fail } from './demo-http'

const ROOT = '/home/demo/projects/shop'
const PROJECT_DIR = `${ROOT}/docs/AgentPanel/Tools`
const GLOBAL_DIR = '/home/demo/.agent-panel/tools'

const sample = (x: Partial<CustomTool> & Pick<CustomTool, 'id' | 'name' | 'run'>): CustomTool =>
  CustomTool.parse({ updatedAt: '2026-11-24T08:30:00.000Z', createdBy: 'Agent', ...x })

// 模块状态：演示的工具只在这一页里，刷新回到样例
const store: Record<ToolScope, CustomTool[]> = {
  project: [
    sample({
      id: 'export-tables',
      name: '导表',
      summary: '把 Excel 配置表导出成 Lua 和 JSON',
      useWhen: '改了 Design/Tables 下的 Excel 配置表之后，要让游戏读到新数据时',
      avoidWhen: '只改了 Lua 代码时不用导表',
      tags: ['配置表'],
      run: {
        command: 'python tools/export_tables.py {{sheet}} --out {{out}}',
        cwd: '.',
        timeoutSec: 300,
        background: 'auto',
      },
      params: [
        {
          name: 'sheet',
          label: '表名',
          type: 'string',
          desc: '只导这一张，留空导全部',
          required: false,
          options: [],
          inProject: true,
        },
        {
          name: 'out',
          label: '输出目录',
          type: 'path',
          desc: '',
          required: false,
          default: 'Content/Config',
          options: [],
          inProject: true,
        },
      ],
      effect: 'write',
      writes: ['Content/Config/**'],
      output: { okExit: [0], errorPattern: '^(?<file>[^:]+\\.xlsx):(?<line>\\d+): (?<msg>.*)$' },
      sources: ['docs/导表说明.md', 'tools/export_tables.py'],
      version: 3,
      history: [
        {
          version: 2,
          at: '2026-11-20T03:00:00.000Z',
          by: 'Agent',
          command: 'python tools/export_tables.py {{sheet}}',
          note: '加了输出目录参数',
        },
        { version: 1, at: '2026-11-18T03:00:00.000Z', by: 'Agent', command: 'python tools/export_tables.py', note: '' },
      ],
    }),
    sample({
      id: 'lua-check',
      name: 'Lua 语法检查',
      summary: '用 luac -p 检查改过的 Lua 文件有没有语法错误',
      useWhen: '改完 Lua 脚本、提交前确认没有语法错误',
      run: { command: 'luac -p {{file}}', cwd: '.', timeoutSec: 60, background: 'never' },
      params: [{ name: 'file', label: '文件', type: 'path', desc: '', required: true, options: [], inProject: true }],
      effect: 'read',
      output: { okExit: [0], errorPattern: '^luac: (?<file>[^:]+):(?<line>\\d+): (?<msg>.*)$' },
    }),
  ],
  global: [
    sample({
      id: 'port-check',
      name: '查端口占用',
      summary: '看某个端口被哪个进程占着',
      useWhen: '服务起不来、报端口被占用时',
      run: {
        command: 'lsof -i :{{port}}',
        win: 'netstat -ano | findstr :{{port}}',
        cwd: '.',
        timeoutSec: 30,
        background: 'never',
      },
      params: [
        {
          name: 'port',
          label: '端口',
          type: 'number',
          desc: '',
          required: true,
          options: [],
          inProject: true,
          min: 1,
          max: 65535,
        },
      ],
      effect: 'read',
    }),
  ],
}
const lastRun = new Map<string, NonNullable<ToolEntry['last']>>()

const fileOf = (scope: ToolScope, id: string) => `${scope === 'project' ? PROJECT_DIR : GLOBAL_DIR}/${id}.json`

function entries(): ToolEntry[] {
  const own = new Set(store.project.map((x) => x.id))
  return (['project', 'global'] as const).flatMap((scope) =>
    store[scope].map((tool) => ({
      scope,
      file: fileOf(scope, tool.id),
      tool,
      ...(scope === 'global' && own.has(tool.id) ? { shadowed: true } : {}),
      ...(lastRun.has(`${scope}:${tool.id}`) ? { last: lastRun.get(`${scope}:${tool.id}`) } : {}),
    })),
  )
}

function save(scope: ToolScope, draft: unknown, replace: boolean, note: string): ToolEntry {
  const r = CustomTool.safeParse({ ...(draft as object), version: 1, history: [] })
  if (!r.success) return fail(r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；'))
  const problems = draftProblems(r.data)
  if (problems.length) return fail(problems.join('；'))
  const list = store[scope]
  const i = list.findIndex((x) => x.id === r.data.id)
  if (i >= 0 && !replace) return fail(`已经有 id 为 ${r.data.id} 的工具了：选「更新它」或换一个 id`)
  const next = nextVersion(r.data, list[i], { by: '我', note, now: new Date().toISOString() })
  if (i >= 0) list[i] = next
  else list.push(next)
  return { scope, file: fileOf(scope, next.id), tool: next }
}

/** 演示的运行：参数校验、命令展开是真的，输出是写好的 */
function run(body: {
  scope?: ToolScope
  id?: string
  draft?: unknown
  args?: Record<string, unknown>
  dryRun?: boolean
}) {
  let tool: CustomTool | undefined
  if (body.draft) {
    const r = CustomTool.safeParse({ ...(body.draft as object), version: 1, history: [] })
    if (!r.success) return fail(r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；'))
    tool = r.data
  } else tool = entries().find((e) => e.tool?.id === body.id && (!body.scope || e.scope === body.scope))?.tool
  if (!tool) return fail('没有这个工具', 404)
  const a = checkArgs(tool, body.args, ROOT)
  if (a.errors.length) return { ok: false, text: a.errors.join('；'), line: '', output: [] }
  const ex = expandCommand(commandTemplate(tool, 'linux'), tool, a.values, 'sh', { projectRoot: ROOT, workDir: ROOT })
  if (ex.error) return { ok: false, text: ex.error, line: ex.line, output: [] }
  if (body.dryRun) return { ok: true, text: ex.line, line: ex.line, output: [] }
  const output = [
    `$ ${ex.line}`,
    '（在线演示不会真的执行命令，下面是示例输出）',
    `读取 ${tool.sources[0] ?? '项目文件'}…`,
    '处理完成：12 项，0 个错误',
  ]
  const result = {
    ok: true,
    code: 0,
    ms: 840,
    line: ex.line,
    errors: [],
    tail: output.slice(-3),
    totalLines: output.length,
  }
  if (body.scope && body.id)
    lastRun.set(`${body.scope}:${body.id}`, {
      at: new Date().toISOString(),
      ok: true,
      ms: 840,
      summary: output.at(-1)!,
    })
  return { ok: true, text: runText(tool, result), line: ex.line, output }
}

/** /custom-tools 下的接口（契约见 shared/api-contract/custom-tools.ts） */
export function demoCustomTools(method: string, seg: string[], body: unknown) {
  const [, scopeRaw, id, action] = seg
  if (method === 'GET' && !scopeRaw) return { entries: entries(), projectDir: PROJECT_DIR, globalDir: GLOBAL_DIR }
  if (method === 'PUT' && !scopeRaw) {
    const b = body as { scope: ToolScope; tool: unknown; replace?: boolean; note?: string }
    return save(b.scope, b.tool, !!b.replace, b.note ?? '')
  }
  if (method === 'POST' && scopeRaw === 'run') return run(body as Parameters<typeof run>[0])
  const scope = ToolScope.safeParse(scopeRaw).data ?? fail('范围不对')
  const list = store[scope]
  const i = list.findIndex((x) => x.id === id)
  if (i < 0) return fail(`没有这个工具：${id}`, 404)
  if (method === 'DELETE') {
    list.splice(i, 1)
    return { ok: true, info: `已删除 ${id}` }
  }
  if (method === 'POST' && action === 'copy') {
    const b = body as { to: ToolScope; move?: boolean }
    const saved = save(b.to, list[i], true, scope === 'project' ? '从项目复制' : '从全局复制')
    if (b.move) list.splice(i, 1)
    return saved
  }
  return fail('演示不支持这个操作', 404)
}
