/**
 * custom_tool：调用项目和全局的自建工具（ADR 0082，/createtool 做出来的）。
 * 一个入口、六个 action（locate 登记程序在本机的位置，shared/custom-tools/programs.ts）。
 * 运行另有直接的入口：每个自建工具各自列成 tool_<id>（custom-tool-direct.ts，ADR 0082 第 9 节），这里的 run 留给没列出的工具和旧会话。
 * 清单、执行、授权、签出、保存弹窗都在服务端（server/custom-tools/agent.ts），这里只管参数、定义和提示词里那一行
 */
import type { Orchestra } from '../../shared/engine/host.ts'
import type { CustomToolCall } from '../../shared/host/custom-tools.ts'
import { str, text, type PanelTool, type ToolResult } from './types.ts'

const ACTIONS = ['list', 'show', 'run', 'test', 'save', 'locate'] as const

export const obj = (v: unknown): Record<string, unknown> | undefined => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  // 有的模型把对象写成 JSON 字符串
  if (typeof v === 'string' && v.trim().startsWith('{'))
    try {
      return JSON.parse(v) as Record<string, unknown>
    } catch {
      return undefined
    }
  return undefined
}

export const CUSTOM_TOOL: PanelTool = {
  name: 'custom_tool',
  when: (o) => !!o.customTools,
  // save 等用户在保存弹窗里点完、run 可能等授权卡和两分钟内的执行
  waits: true,
  // 清单那一行由服务端按工具的「什么时候用」生成；一个工具都没有时不出现
  hint: (o, at) => (at === 'conv' || at === 'chat' || at === 'helper' ? (o.customTools?.hint ?? '') : ''),
  def: () => ({
    name: 'custom_tool',
    title: '自建工具',
    description:
      '自建工具的管理入口。用户做好的自建工具（导表、Lua 检查、打包这类）已经各自列成 tool_<id> 工具，要跑哪个直接调那个工具，不用经这里、也不用先 list / show。' +
      '这里用来：list 看全部（query 过滤）；show 看一个的命令和参数；run（id + args）跑清单里没列出的工具。' +
      'locate：项目要用、又不在 PATH 里的程序（luac、导表工具）你找到了位置，就写 program + path 登记，之后这个项目的对话开头都带上它，不用每次全盘找；只写 program 查登记的位置，forget=true 删掉。' +
      '做新工具（用户用 /createtool 要求时）：先 list 看有没有同类的，再读文档和脚本写草稿 draft，test 试跑（dryRun=true 只展开命令不执行），最后 save 交给用户选存到项目还是全局，用户点完才返回。' +
      'draft 的格式：{id: 小写英文和-, name: 中文名, summary, useWhen, avoidWhen, run: {command: "python x.py {{sheet}}", win?, posix?, script?: {ext, text}, cwd: ".", timeoutSec}, params: [{name, label, type: string|number|boolean|enum|path, desc, required, default, options, flag}], effect: read|write|external, writes: ["Content/Config/**"], output: {okExit: [0], errorPattern?: "(?<file>..):(?<line>\\\\d+): (?<msg>.*)"}, role?: {kind: verify|build, paths: ["**/*.lua"], replaces: ["luac"]}, sources: [依据的文件]}；' +
      'role：检查类（语法检查、lint）写 verify + paths（只读的才行），面板在 Agent 改完对得上的文件后自己跑、只推报错；编译脚本写 build；replaces 写它能顶替的程序名。' +
      '命令里用 {{参数名}}，面板自带 {{projectRoot}} {{workDir}} {{docRoot}} {{script}}；参数值面板会加引号，模板里不要再加。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...ACTIONS] },
        id: { type: 'string', description: 'show / run：工具 id' },
        args: { type: 'object', description: 'run / test：参数，按 show 列的名字填' },
        query: { type: 'string', description: 'list：按名字、说明过滤' },
        draft: { type: 'object', description: 'test / save：工具草稿（格式见说明）' },
        dryRun: { type: 'boolean', description: 'test：只展开命令、不执行' },
        note: { type: 'string', description: 'save：这一版是怎么来的（给用户看）；locate：这个程序干什么用（一句话）' },
        program: { type: 'string', description: 'locate：程序名，例如 luac' },
        path: { type: 'string', description: 'locate：这台电脑上的完整路径' },
        forget: { type: 'boolean', description: 'locate：true 删掉这条登记' },
      },
      required: ['action'],
    },
  }),
  call: (o, a, signal) => {
    const action = str(a?.action) as (typeof ACTIONS)[number]
    if (!ACTIONS.includes(action)) return text(`action 只能是 ${ACTIONS.join(' / ')}`, true)
    return callCustom(
      o,
      {
        action,
        id: str(a?.id) || undefined,
        query: str(a?.query) || undefined,
        args: obj(a?.args),
        draft: obj(a?.draft),
        dryRun: a?.dryRun === true || a?.dryRun === 'true',
        note: str(a?.note) || undefined,
        program: str(a?.program) || undefined,
        path: str(a?.path) || undefined,
        forget: a?.forget === true || a?.forget === 'true',
      },
      signal,
    )
  },
}

/** 交给服务端执行（custom_tool 和直接调的 tool_<id> 共用）：守卫、后台命令挂在 Orchestra 上，服务端拿不到 */
export async function callCustom(o: Orchestra, req: CustomToolCall, signal?: AbortSignal): Promise<ToolResult> {
  if (!o.customTools) return text('这里用不了自建工具（面板没给这个对话挂上）', true)
  const r = await o.customTools.call(req, {
    signal,
    guard: o.guardCommand,
    background: o.canBackground ? (input) => o.runBackground({ ...input, exclusive: false }) : undefined,
  })
  return text(r.text, !!r.error)
}
