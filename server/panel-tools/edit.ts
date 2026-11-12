/** 改文件前的几步：开独立分支（begin_edit）、父对话就地微改动（begin / end_inline_edit）、就地加载挂载的能力 */
import { INLINE_EDIT_MAX_FILES, INLINE_EDIT_MAX_LINES } from '../../shared/inline-edit.ts'
import { routeField, routeOf } from '../orch-fields.ts'
import { noArgs, reply, str, type PanelTool } from './types.ts'

export const BEGIN_EDIT: PanelTool = {
  name: 'begin_edit',
  when: (o) => o.canBeginEdit,
  def: () => ({
    name: 'begin_edit',
    title: '开独立分支',
    description:
      '确定要改文件时先调用：面板从当前目录开一个独立分支。成功后用一两句写下查到的情况和打算怎么改，然后马上结束这一轮，面板会切到独立分支的目录里接着做。调用前不要改任何文件。',
    inputSchema: noArgs(),
  }),
  hint: (_o, at) => (at === 'conv' ? '改文件前先调用 begin_edit 开独立分支，开好后结束这一轮；' : ''),
  call: async (o) => reply(await o.beginEdit()),
}

export const INLINE_EDIT: PanelTool[] = [
  {
    name: 'begin_inline_edit',
    when: (o) => o.inlineEdit,
    def: () => ({
      name: 'begin_inline_edit',
      title: '开始就地改动',
      description: `父对话就地做一个微小改动前调用：改什么、改成什么已经清楚、不用排查，最多 ${INLINE_EDIT_MAX_FILES} 个文件、${INLINE_EDIT_MAX_LINES} 行以内（文案、配置值、一两行文档）。面板校验子对话有没有在合回、要改的文件有没有子对话在用；通过后你改文件、跑项目的快速检查、本地提交，再调用 end_inline_edit。Bug、要排查的、改公共接口或数据格式的都交给子对话，不走这里。`,
      inputSchema: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: { type: 'string' },
            description: `要改的文件（相对项目根），最多 ${INLINE_EDIT_MAX_FILES} 个；同一提交该带的（例如文案的英文翻译）也列上`,
          },
          reason: { type: 'string', description: '改什么、为什么能就地改' },
          route: routeField(),
        },
        required: ['files', 'reason'],
      },
    }),
    call: async (o, a) => {
      const files = Array.isArray(a?.files) ? a.files.map(String).filter((f: string) => f.trim()) : []
      return reply(await o.beginInlineEdit(files, str(a?.reason), routeOf(a?.route)))
    },
  },
  {
    name: 'end_inline_edit',
    when: (o) => o.inlineEdit,
    def: () => ({
      name: 'end_inline_edit',
      title: '结束就地改动',
      description:
        '就地改动改完、跑过快速检查并本地提交后调用：面板按真实改动核对文件数、行数和没声明的文件，越界会提示用户；然后恢复子对话的收尾。这一轮结束时没调用也会自动收。',
      inputSchema: noArgs(),
    }),
    call: async (o) => reply(await o.endInlineEdit()),
  },
]

export const USE_CAPABILITY: PanelTool = {
  name: 'use_capability',
  when: (o) => o.capabilities,
  def: () => ({
    name: 'use_capability',
    title: '加载能力',
    description:
      '就地用你挂载的某个能力前调用：取它的完整做法、参数和要用的 Skill，再在当前对话里按它做。只能派出的能力（例如评审）会被拒绝并告诉你怎么派。能力列表见角色设定里「你挂载的能力」。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '能力的名字，例如「测试验收」' },
        params: {
          type: 'object',
          description: '这次用的参数取值（可选），例如 {"scope": "快速"}；不写按挂载上的取值',
        },
      },
      required: ['name'],
    },
  }),
  call: (o, a) => {
    const params = a?.params && typeof a.params === 'object' && !Array.isArray(a.params) ? a.params : undefined
    return reply(o.loadCapability(str(a?.name), params))
  },
}
