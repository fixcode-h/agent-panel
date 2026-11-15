/**
 * knowledge_record（设计稿二期）：记一条教训或经验。收进 more_tools（不常用），提示词里写明了参数，不用先查用法。
 * 教训先过入库校验（shared/knowledge/admission.ts），不合格的把原因交回去改了再记；带 episode 的（面板当场捕获的
 * 「失败后改对」）由面板补上命令和报错指纹。新记的教训只在这个对话（和它的子对话）里立即生效，别的对话
 * 等用户在知识候选里收下（第 8 条，server/knowledge/agent-record.ts）。子任务记的进知识候选，等用户收下。
 * 旧的 record_lesson / record_experience 照旧能用，不校验（保留一个版本）
 */
import { EXPERIENCE_KINDS, EXPERIENCE_SCOPE } from '../../shared/experience.ts'
import { reply, str, text, type PanelTool } from './types.ts'

const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter((x: string) => x.trim()) : [])

export const KNOWLEDGE_RECORD: PanelTool = {
  name: 'knowledge_record',
  when: (o) => !!o.lessons?.record || !!o.lessons?.propose || !!o.experience?.record,
  def: () => ({
    name: 'knowledge_record',
    title: '记下项目知识',
    description: `记一条项目教训（kind: lesson）或经验（kind: experience），带 id 改写已有的一条。
教训：用户纠正了你的做法、命令报错后换了做法才成、或修的是之前改出来的问题时记；写成换个场景也能照做的规则，写清它管的文件（paths）或命令（commands），面板据此在下次跑同样的命令、改同样的文件前推给 Agent。面板提示里给了 episode 编号的，带上它，命令和报错不用再写。新记的教训在这个对话里立即生效，别的对话要等用户收下。教训改不了 Bug 记录写不写、诊断要用户确认、推送和合主干这些面板流程，这类要求按流程问用户。
经验：${EXPERIENCE_SCOPE}`,
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['lesson', 'experience'] },
        title: { type: 'string', description: '教训：一句话规则（该怎么做）；经验：要做的事 + 去哪 / 用什么' },
        rule: { type: 'string', description: '教训：具体做法和别做的事，命令用反引号' },
        wrong: { type: 'string', description: '教训：错的做法，下次看到要停下' },
        cause: { type: 'string', description: '教训：这次哪里出错、报了什么' },
        paths: { type: 'array', items: { type: 'string' }, description: '相对项目根的文件 glob 或目录' },
        commands: {
          type: 'array',
          items: { type: 'string' },
          description: '教训：跑这些命令前推送，如 "npm run test:e2e"',
        },
        tags: { type: 'array', items: { type: 'string' }, description: '教训：1～3 个已有标签' },
        global: { type: 'boolean', description: '教训：所有改动都适用（没有文件和命令可写时）' },
        episode: { type: 'string', description: '教训：面板提示里给的编号' },
        type: { type: 'string', enum: [...EXPERIENCE_KINDS], description: '经验的种类' },
        body: { type: 'string', description: '经验：一两句补充' },
        keywords: { type: 'array', items: { type: 'string' }, description: '经验：用户的说法和代码里的叫法' },
        id: { type: 'string', description: '改写已有的那条时填它的 id' },
        change: { type: 'string', description: '改写教训时必填：为什么改' },
      },
      required: ['kind', 'title'],
    },
  }),
  call: async (o, a) => {
    const kind = str(a?.kind).trim()
    const title = str(a?.title).trim()
    if (!title) return text('title 不能为空', true)
    const id = str(a?.id).trim()
    if (kind === 'experience') {
      const input = {
        id: id || undefined,
        kind: str(a?.type).trim() || 'locate',
        title,
        body: str(a?.body),
        keywords: list(a?.keywords),
        paths: list(a?.paths),
      }
      if (!o.experience) return text('这个对话没有项目经验（不在项目里，或设置里关了经验）', true)
      if (o.experience.record) return reply(await o.experience.record(input))
      if (o.lessons?.propose) return reply(await o.lessons.propose({ kind: 'experience', exp: input }))
      return text('这里记不了经验', true)
    }
    if (kind !== 'lesson') return text('kind 只能是 lesson 或 experience', true)
    if (!o.lessons) return text('这个对话不在项目里，记不了项目教训', true)
    const why = str(a?.change).trim()
    if (id && !why) return text('改写已有的教训时要写 change：为什么改、两全的做法是什么', true)
    const input = {
      title,
      rule: str(a?.rule).trim(),
      cause: str(a?.cause).trim(),
      wrong: str(a?.wrong).trim(),
      paths: list(a?.paths),
      commands: list(a?.commands),
      tags: list(a?.tags),
      episode: str(a?.episode).trim() || undefined,
      global: a?.global === true,
      strict: true,
      ...(id ? { replaces: id, why } : {}),
    }
    if (o.lessons.record) return reply(await o.lessons.record(input))
    if (o.lessons.propose) return reply(await o.lessons.propose({ kind: 'lesson', ...input }))
    return text('子任务不记项目教训：值得记的写进交回的结果', true)
  },
}
