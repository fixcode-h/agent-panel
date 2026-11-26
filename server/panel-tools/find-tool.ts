/**
 * find：找文件、找代码的唯一入口（ADR 0081 能力路由；取代 file_index，旧名照样执行）。
 * - 找文件（file / list / refresh / status）查面板的文件名索引（server/file-index/agent-tool.ts）；
 * - 找代码（symbol / refs / outline / members / include / text）交给能力路由，面板按语言挑 VS、IDEA 或文本兜底
 *   （server/capability-router/find/run.ts）。Agent 只说要找什么，不用知道哪个服务开着、参数怎么拼。
 * 只管参数和定义；一个工具不超过 10 个 action（ADR 0067）：rebuild 并进 refresh 的 full
 */
import { findRequestOf, isFindKind } from '../../shared/capability-router/find/request.ts'
import type { FileIndexArgs } from '../../shared/host/file-index.ts'
import type { ToolRoute } from '../../shared/capability-router/tool-route.ts'
import { t } from '../../shared/i18n.ts'
import { str, text, type PanelTool } from './types.ts'

const FILE_ACTIONS = ['file', 'list', 'refresh', 'status'] as const
const CODE_ACTIONS = ['symbol', 'refs', 'outline', 'members', 'include', 'text'] as const
const ACTIONS = [...FILE_ACTIONS, ...CODE_ACTIONS]
/** file_index 时代的写法：find 是按名字找文件，rebuild 是整份重建 */
const OLD: Record<string, string> = { find: 'file', rebuild: 'refresh' }

const list = (v: unknown) =>
  Array.isArray(v)
    ? v.map(String).filter((x) => x.trim())
    : typeof v === 'string' && v.trim()
      ? v
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
      : undefined
const num = (v: unknown) => (v === undefined || v === '' ? undefined : Number(v))
const yes = (v: unknown) => v === true || v === 'true'
/** 在对话里认出是哪一行 find 调用用的词：查询词，没有就是文件或目录 */
const needleOf = (a: Record<string, unknown> | undefined) => str(a?.query) || str(a?.file) || str(a?.dir) || ''

function fileIndexRoute(ms: number, failed: boolean): ToolRoute {
  const hop = { source: 'panel.files', label: t('文件索引'), via: 'panel' as const }
  return {
    capability: 'find',
    served: failed ? [] : [hop],
    steps: [{ ...hop, outcome: failed ? 'failed' : 'used', ms }],
    ms,
  }
}

export const FIND: PanelTool = {
  name: 'find',
  aliases: ['file_index'],
  when: (o) => !!o.fileIndex || !!o.findCode,
  def: () => ({
    name: 'find',
    title: '查找',
    description:
      '找文件、找代码都用它：面板按语言挑最好的路（C++ 用 VS 的符号索引、Lua 用 IDEA 的 emmylua，都用不了时面板按文本找），结果统一成「路径:行: 内容」。' +
      '找文件：action=file 按名字（query 里空格分隔的词都要命中文件名，带 / 按路径，带 * ? 按通配），action=list 列目录（dir，recursive 取整棵子树）；' +
      '索引不收排除目录（Saved、Intermediate 这类）。action=refresh 让索引按目录核对（dir 只核对那棵子树，full=true 整份重建），action=status 看状态。' +
      '找代码：action=symbol 找声明（函数、类、变量，query 可写 A::B、A.B、A:B），refs 找引用（同名多时带 file、line 指明哪一个），outline 列文件大纲（query 写文件），' +
      'members 列类成员，include 查类该 include 哪个头文件，text 按原文搜内容。under、ext 限定范围；lang（cpp / lua）一般不用给，面板按扩展名、目录、写法推。' +
      '结果分页：limit 默认 50，按结果末尾给的 offset 往下翻。服务在启动或建索引时面板会等它（最多一分钟），不用重试。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...ACTIONS], description: '默认 file' },
        query: {
          type: 'string',
          description:
            'file：文件名里的词；symbol / refs / members / include：名字；outline：文件路径；text：要搜的文本',
        },
        dir: { type: 'string', description: 'list / refresh：目录，相对项目根或绝对路径' },
        under: { type: 'array', items: { type: 'string' }, description: '只在这些目录里找' },
        ext: { type: 'array', items: { type: 'string' }, description: '只要这些扩展名，例如 ["lua"]' },
        file: { type: 'string', description: 'refs：符号所在文件' },
        line: { type: 'number', description: 'refs：符号所在行' },
        lang: { type: 'string', enum: ['cpp', 'lua'], description: '代码语言，推不准时才给' },
        wide: { type: 'boolean', description: '代码查找把引擎、库这些项目外的也算上' },
        dirs: { type: 'boolean', description: 'file：找目录而不是文件' },
        recursive: { type: 'boolean', description: 'list：整棵子树的文件' },
        full: { type: 'boolean', description: 'refresh：整份重建' },
        limit: { type: 'number', description: '每页条数，默认 50' },
        offset: { type: 'number', description: '从第几条开始' },
      },
    },
  }),
  call: async (o, a, signal) => {
    const raw = str(a?.action) || 'file'
    const action = OLD[raw] ?? raw
    if (!(ACTIONS as string[]).includes(action)) return text(`action 只能是 ${ACTIONS.join(' / ')}`, true)

    if (isFindKind(action)) {
      if (!o.findCode) return text('这个对话不在项目里，没法按代码查找：用 rg 搜内容', true)
      const req = findRequestOf(action, a ?? {})
      if (typeof req === 'string') return text(req, true)
      const r = await o.findCode(req, signal)
      if (r.route) o.noteRoute?.(r.route, needleOf(a))
      return text(r.text, !!r.error)
    }

    if (!o.fileIndex) return text('项目设置里关了文件索引：按名字找文件直接用 rg --files', true)
    const fileAction: FileIndexArgs['action'] =
      action === 'file'
        ? 'find'
        : action === 'refresh' && (yes(a?.full) || raw === 'rebuild')
          ? 'rebuild'
          : (action as FileIndexArgs['action'])
    const t0 = Date.now()
    const r = await o.fileIndex(
      {
        action: fileAction,
        query: str(a?.query) || undefined,
        dir: str(a?.dir) || undefined,
        under: list(a?.under),
        ext: list(a?.ext),
        dirs: yes(a?.dirs),
        recursive: yes(a?.recursive),
        limit: num(a?.limit),
        offset: num(a?.offset),
      },
      signal,
    )
    // 找文件只有一条路（面板的文件名索引），卡片上照样写出来：用户一眼分得清是查代码还是找文件
    o.noteRoute?.(fileIndexRoute(Date.now() - t0, !!r.error), needleOf(a))
    return text(r.text, !!r.error)
  },
}
