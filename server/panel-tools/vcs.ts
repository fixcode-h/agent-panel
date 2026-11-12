/** 版本管理相关：P4 按类型分 changelist、cherry-pick 到项目设置的目标 */
import { reply, str, text, type PanelTool } from './types.ts'

export const P4_SPLIT: PanelTool = {
  name: 'p4_split_changelists',
  when: (o) => !!o.p4Split,
  def: () => ({
    name: 'p4_split_changelists',
    title: '按类型分 changelist',
    description:
      'P4 工作区：把改动按文件类型分进各自的 pending changelist（[C++]、[XLSX] 表格、[Lua]、[Other] 各一个），由面板建 changelist 并挪文件，不 submit。要把改动放进 pending 时用它，不要自己建一个把几类混在一起的。缺哪类的描述会先列出各类文件、不动任何东西。',
    inputSchema: {
      type: 'object',
      properties: {
        descriptions: {
          type: 'object',
          description:
            '这次有文件的每一类写一句中文描述，只说改了什么（25 字以内，英文数字算半个；不带 [类型] 标签，不写原因、函数名和文件列表；超长会被退回）',
          properties: {
            'C++': { type: 'string' },
            XLSX: { type: 'string', description: '表格：.xlsx / .xls / .csv 等' },
            Lua: { type: 'string' },
            Other: { type: 'string' },
          },
        },
        from: {
          type: 'string',
          description:
            '从哪个 changelist 分：不写是 default；写 pending 的编号会把混在里面的几类拆开（挪空后删掉原来的）',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description:
            '只分这些文件（本地路径或 depot 路径）；不写分来源里的全部文件。default 里有别的改动时用它只列本次任务的',
        },
      },
      required: ['descriptions'],
    },
  }),
  call: async (o, a) => {
    if (!o.p4Split) return text('这里不是 P4 工作区', true)
    const d = a?.descriptions && typeof a.descriptions === 'object' ? (a.descriptions as Record<string, unknown>) : {}
    const descriptions = Object.fromEntries(
      (['C++', 'XLSX', 'Lua', 'Other'] as const).filter((k) => typeof d[k] === 'string').map((k) => [k, String(d[k])]),
    )
    const files = Array.isArray(a?.files) ? a.files.map(String) : undefined
    return reply(await o.p4Split({ descriptions, from: str(a?.from) || undefined, files }))
  },
}

export const CHERRY_PICK: PanelTool = {
  name: 'cherry_pick',
  when: (o) => !!o.cherryPick,
  def: () => ({
    name: 'cherry_pick',
    title: 'cherry-pick 到目标',
    description:
      '用户要求把改动 cherry-pick 到项目设置的目标时用它，由面板核对后执行。Git 写 commits（这个对话做的提交，按先后顺序；有不是这次修改的提交整次不做）；P4 写 changelist（用户要搬的 pending，或已经 submit 的编号，别的 stream 上的也行；面板只搬这个 changelist 自己的改动，在目标工作区建一个对应的 pending，不 submit，用户明确要求前也不要自己 p4 submit）。不要自己跑 git cherry-pick / merge、p4 integrate / merge / copy 或复制文件过去；被拒绝时把原因告诉用户；有冲突时面板把冲突留在目标里，把冲突文件和位置告诉用户，由用户自己解决。',
    inputSchema: {
      type: 'object',
      properties: {
        commits: { type: 'array', items: { type: 'string' }, description: 'Git：这个对话做的提交哈希' },
        changelist: {
          type: 'string',
          description: 'P4：要搬的 changelist 编号（还没提交的 pending，或已经 submit 的）',
        },
      },
    },
  }),
  call: async (o, a) => {
    if (!o.cherryPick) return text('这个项目没有设置 cherry-pick 目标，请用户到项目设置里设', true)
    const commits = Array.isArray(a?.commits) ? a.commits.map(String) : undefined
    return reply(await o.cherryPick({ commits, changelist: str(a?.changelist) || undefined }))
  },
}
