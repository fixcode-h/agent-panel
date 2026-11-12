/** 执行计划：set_plan / finish_plan（对话有计划时才有，Orchestra.plans） */
import { planItem } from '../orch-fields.ts'
import { reply, str, text, type PanelTool } from './types.ts'

export const PLAN_TOOLS: PanelTool[] = [
  {
    name: 'set_plan',
    when: (o) => o.plans,
    def: () => ({
      name: 'set_plan',
      title: '更新计划',
      description:
        '列出或更新这个对话的执行计划，每次交整份列表（已有的步骤带 id）。最多两层：主步骤和子步骤。一份计划里同时只能有一个步骤是「进行中」（同一层）；跑长命令、派子对话前用带 step 的参数把它变成等待中。同一件事的细化 / 插一步 / 调顺序用 partial 只交变更项；目标变了（换方向、大部分步骤作废）先 finish_plan 结束这份计划、再带新 title 开新的，不要在同一份里大换血。步骤一多（10 条以上）就分两批交：一批带 partial: true 只写要变的步骤，没写到的步骤留在计划里不动，免得一次拼一大段 JSON 拼错。完成的步骤不能再改，同样的内容要再做就新加一步；步骤全部完成后这份计划就结束，之后的新内容直接开新计划。新开计划、整份提交时返回合并后的计划和每一步的 id；partial 只返回变了的步骤（新步骤带 id）和进度、下一步，完整计划每轮提示里都有。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '这份计划的名字（开新计划时写）' },
          summary: {
            type: 'string',
            description:
              '把最后几步标完成、计划随之结束时一起交：这份计划的总结（做了什么、结果、遗留），记在你自己的计划上',
          },
          partial: {
            type: 'boolean',
            description:
              '只交变更步骤：为 true 时没写到的步骤留在计划里不动（不删、不重新计数）；新加的步骤照常追加。默认 false：没写到的未完成步骤算删掉',
          },
          steps: {
            type: 'array',
            description: '主步骤，按执行顺序',
            items: {
              ...planItem,
              properties: {
                ...planItem.properties,
                children: { type: 'array', description: '子步骤（只能一层）', items: planItem },
              },
            },
          },
        },
        required: ['steps'],
      },
    }),
    hint: (_o, at) =>
      at === 'chat'
        ? 'set_plan / finish_plan 列执行计划、更新进度；'
        : at === 'conv'
          ? 'set_plan 列执行计划、随时更新进度；'
          : '',
    call: async (o, a) =>
      reply(
        await o.setPlan({
          title: str(a?.title),
          steps: Array.isArray(a?.steps) ? a.steps : [],
          partial: a?.partial === true,
          summary: str(a?.summary),
        }),
      ),
  },
  {
    name: 'finish_plan',
    when: (o) => o.plans,
    def: () => ({
      name: 'finish_plan',
      title: '结束计划',
      description:
        '主动结束这份计划（步骤全部完成时计划本来就会自动结束）。summary 写这份计划的总结（做了什么、结果、遗留），记在你自己的计划上；之后有新内容用 set_plan 开新计划。',
      inputSchema: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: '这份计划的总结：做了什么、结果、遗留；父对话和用户读它了解你做完了什么',
          },
        },
      },
    }),
    call: async (o, a) => reply(await o.finishPlan(str(a?.summary))),
  },
]

/** 老会话里模型还记得 start_plan：说清楚现在归谁，不悄悄吞掉（不再列出） */
export const START_PLAN: PanelTool = {
  name: 'start_plan',
  when: () => false,
  call: () => text('子对话不再启动工作流：工作流由父对话用 start_workflow 启动，按派给你的事直接做', true),
}
