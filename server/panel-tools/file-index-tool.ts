/**
 * file_index（设计稿：项目文件索引）：按名字找文件、按文件夹取、核对 / 重建索引。
 * 只在项目开着文件索引时列出；查询在服务端（server/file-index/agent-tool.ts），这里只管参数和定义
 */
import type { FileIndexArgs } from '../../shared/host/file-index.ts'
import { str, text, type PanelTool } from './types.ts'

const ACTIONS = ['find', 'list', 'refresh', 'rebuild', 'status'] as const
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

export const FILE_INDEX: PanelTool = {
  name: 'file_index',
  when: (o) => !!o.fileIndex,
  def: () => ({
    name: 'file_index',
    title: '查文件索引',
    description:
      '查项目的文件名索引（面板维护，只记文件名和位置，不含内容；不收项目设置里的排除目录）。action=find 按名字找：query 里空格分隔的词都要命中文件名，带 / 的词按路径匹配，带 * ? 的按通配；under 限定目录，ext 限定扩展名。action=list 列一个目录（dir），recursive 取整棵子树的文件。结果分页（limit 默认 50，offset 往下翻）。索引还没建好时会等它建好再回答（最多一分钟）。action=refresh 让索引按目录核对一遍（dir 只核对那棵子树），action=rebuild 整份重建，action=status 看状态。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...ACTIONS], description: 'find（默认）/ list / refresh / rebuild / status' },
        query: {
          type: 'string',
          description: 'find：文件名里的词，空格分隔；例如 "player controller"、"*.uasset"、"Source/ cart"',
        },
        dir: { type: 'string', description: 'list / refresh：目录，相对项目根或绝对路径；list 留空是项目根' },
        under: { type: 'array', items: { type: 'string' }, description: 'find：只在这些目录里找' },
        ext: { type: 'array', items: { type: 'string' }, description: '只要这些扩展名，例如 ["ts","tsx"]' },
        dirs: { type: 'boolean', description: 'find：找目录而不是文件' },
        recursive: { type: 'boolean', description: 'list：整棵子树的文件（默认只列这一层）' },
        limit: { type: 'number', description: '每页条数，默认 50，最多 500' },
        offset: { type: 'number', description: '从第几条开始，翻页用上次结果给的 nextOffset' },
      },
    },
  }),
  call: async (o, a, signal) => {
    if (!o.fileIndex) return text('这个对话不在项目里，或项目设置里关了文件索引：直接用 rg --files / find 找', true)
    const action = (str(a?.action) || 'find') as FileIndexArgs['action']
    if (!ACTIONS.includes(action)) return text(`action 只能是 ${ACTIONS.join(' / ')}`, true)
    const r = await o.fileIndex(
      {
        action,
        query: str(a?.query) || undefined,
        dir: str(a?.dir) || undefined,
        under: list(a?.under),
        ext: list(a?.ext),
        dirs: a?.dirs === true || a?.dirs === 'true',
        recursive: a?.recursive === true || a?.recursive === 'true',
        limit: num(a?.limit),
        offset: num(a?.offset),
      },
      signal,
    )
    return text(r.text, !!r.error)
  },
}
