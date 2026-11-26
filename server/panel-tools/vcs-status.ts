/**
 * vcs_status：版本管理状态一览（2026-11-26 复盘 §5-5）。
 * 准入（ADR 0067）：CLI 能自己跑 p4 / git，但不知道这个对话改过哪些文件（面板记的 task.changes），
 * 收尾节点要一个个 opened / fstat / diff 才拼得出「落后、别人开着、二进制」，复盘里花了约 6 分钟；
 * 并不进已有工具（p4_split_changelists 会改东西、只管 P4，find 是找代码）；结果是文字，Agent 拿得到；只读。
 * 问 Git / P4、拼文字都在服务端（server/vcs/status.ts），这里只管参数和定义
 */
import { text, type PanelTool } from './types.ts'

export const VCS_STATUS: PanelTool = {
  name: 'vcs_status',
  when: (o) => !!o.vcsStatus,
  def: () => ({
    name: 'vcs_status',
    title: '版本管理状态',
    description:
      '一次列出这个对话改过的文件（P4 还有工作目录下打开着的）：加减行数、和库里最新比是否落后、别人是否也打开着、是否二进制，Git / P4 都行，只读。' +
      '提交、分 changelist、收尾交接前先调一次，代替逐个 p4 opened / fstat / diff、git status / diff。' +
      '结果里「要先问用户」的文件（二进制且落后或别人也开着）不要自己覆盖或提交，交给用户决定。Git 的「落后」按上次 fetch 的上游算，面板不 fetch。',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string' },
          description: '只看这些文件（相对工作目录或绝对路径）；不写看这个对话的全部改动',
        },
      },
    },
  }),
  call: async (o, a) => {
    if (!o.vcsStatus) return text('这里没有版本管理状态：不在项目目录里', true)
    const files = Array.isArray(a?.files) ? a.files.map(String).filter((f: string) => f.trim()) : undefined
    return text(await o.vcsStatus.call({ files }))
  },
}
