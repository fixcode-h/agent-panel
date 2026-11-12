/**
 * 项目教训（project_lessons / record_lesson）和项目经验（project_experience / record_experience）。
 * 子任务只查不记（makeOrchestra 给子任务的 lessons / experience 没有 record）：值得记的交回派它的对话决定
 */
import { EXPERIENCE_KINDS, EXPERIENCE_SCOPE } from '../../shared/experience.ts'
import { reply, str, text, type PanelTool } from './types.ts'

const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter((x: string) => x.trim()) : [])

export const LESSON_TOOLS: PanelTool[] = [
  {
    name: 'project_lessons',
    when: (o) => !!o.lessons,
    def: () => ({
      name: 'project_lessons',
      title: '查看项目教训',
      description:
        '取这个项目的教训（以前返工过的地方写成的规则）：传要改的文件，返回管这些文件的条目全文，最相关的在前；也能按关键词或标签查（例如不对应具体文件的条目、提示里只列了标题的条目）；什么都不传列出全部标题和已有标签。动手改文件前用。',
      inputSchema: {
        type: 'object',
        properties: {
          files: { type: 'array', items: { type: 'string' }, description: '要改的文件或目录，相对项目根' },
          query: {
            type: 'string',
            description:
              '关键词，空格分开的几个词都要出现（标题、说明、起因、范围、标签或 id 里）；传 id 取那一条的全文',
          },
          tags: { type: 'array', items: { type: 'string' }, description: '带其中任一个标签的条目' },
        },
      },
    }),
    call: async (o, a) => {
      if (!o.lessons) return text('这个对话不在项目里，没有项目教训', true)
      const files = Array.isArray(a?.files) ? a.files.map(String) : []
      const tags = Array.isArray(a?.tags) ? a.tags.map(String) : []
      return text(await o.lessons.find(files, { query: str(a?.query), tags }))
    },
  },
  {
    name: 'record_lesson',
    when: (o) => !!o.lessons?.record,
    def: () => ({
      name: 'record_lesson',
      title: '记下教训',
      description:
        '记一条项目教训，或改写已有的一条，以后这个项目里的 Agent 改到相关文件时都会看到。用户纠正了你的做法、你发现自己的办法不对换了做法才成、或你在修之前改出来的问题时用；写成通用规则，同类的已经有了就带 id 改写那一条。用户的新要求和某条教训冲突且找到两全的做法时，也带 id 改写并在 change 里说明。全局教训只有用户能改。',
      inputSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description:
              '一句话的规则：该怎么做（不是发生了什么），例如「CLI 才有的能力写进 CLI 的配置字段，代码按字段走」',
          },
          rule: { type: 'string', description: '展开说明：具体到文件、字段、做法和不要做的事' },
          cause: { type: 'string', description: '起因：这次哪里返工、用户怎么纠正的，一两句' },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: '它管哪些文件（相对项目根的 glob，** 跨目录，目录名也行）；所有改动都适用时不写',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description:
              '1～3 个主题标签（例如 并发、测试、界面），最多 5 个；先用提示或 project_lessons 列出的已有标签，不另造近义词',
          },
          id: {
            type: 'string',
            description:
              '改写已有的那条时填它的 id（project_lessons 或提示里列出的）：用户的新要求和它冲突、你找到两全的做法时用；新记一条不填',
          },
          change: {
            type: 'string',
            description: '改写时必填：用户的哪条新要求和原来的规则冲突、两全的做法是什么',
          },
        },
        required: ['title', 'rule'],
      },
    }),
    call: async (o, a) => {
      if (!o.lessons) return text('这个对话不在项目里，记不了项目教训', true)
      // 子任务没注册这个工具，但模型可能凭别处看到的名字直接调：说清楚该怎么办，不悄悄吞掉
      if (!o.lessons.record) return text('子任务不记项目教训：值得记的写进交回的结果，由派你的对话决定要不要记', true)
      const title = str(a?.title).trim()
      if (!title) return text('title 不能为空：写一句该怎么做的规则', true)
      const paths = Array.isArray(a?.paths) ? a.paths.map(String).filter((p: string) => p.trim()) : []
      const replaces = str(a?.id).trim()
      const why = str(a?.change).trim()
      if (replaces && !why) return text('改写已有的教训时要写 change：用户的哪条新要求和它冲突、两全的做法是什么', true)
      return reply(
        await o.lessons.record({
          title,
          rule: str(a?.rule).trim(),
          cause: str(a?.cause).trim(),
          paths,
          tags: Array.isArray(a?.tags) ? a.tags.map(String) : [],
          ...(replaces ? { replaces, why } : {}),
        }),
      )
    },
  },
]

export const EXPERIENCE_TOOLS: PanelTool[] = [
  {
    name: 'project_experience',
    when: (o) => !!o.experience,
    def: () => ({
      name: 'project_experience',
      title: '查项目经验',
      description:
        '查这个项目以前的对话学到的经验：某类东西在哪个目录、用户的说法在代码里叫什么、编译测试用什么命令、怎么验证。要在全项目搜索、或要试命令之前先按关键词查（用户的说法和代码里的叫法都可以），命中了直接去对应位置；对不上时照常找。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，空格分开，例如「表格 掉落」「编译 游戏模块」' },
          files: { type: 'array', items: { type: 'string' }, description: '可选：要看或要改的文件、目录' },
        },
      },
    }),
    call: async (o, a) => {
      if (!o.experience) return text('这个对话没有项目经验（不在项目里，或设置里关了经验）', true)
      const files = Array.isArray(a?.files) ? a.files.map(String) : []
      return text(await o.experience.find(str(a?.query), files))
    },
  },
  {
    name: 'record_experience',
    when: (o) => !!o.experience?.record,
    def: () => ({
      name: 'record_experience',
      title: '记下项目经验',
      description: `记一条项目经验（用户用 /learn 让你学一件事时用），或带 id 更新已有的一条。\n\n${EXPERIENCE_SCOPE}`,
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...EXPERIENCE_KINDS], description: '种类' },
          title: { type: 'string', description: '一句话：要做的事 + 去哪 / 用什么' },
          body: { type: 'string', description: '一两句补充：路径之间的关系、命令参数、别走的弯路' },
          keywords: {
            type: 'array',
            items: { type: 'string' },
            description: '检索用：用户的说法和代码里的叫法都写上',
          },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: '相对项目根的目录或 glob（必须存在）；命令类写命令本身',
          },
          id: { type: 'string', description: '更新已有的那条时填它的 id（project_experience 查到的）' },
        },
        required: ['kind', 'title', 'keywords'],
      },
    }),
    call: async (o, a) => {
      if (!o.experience) return text('这个对话没有项目经验（不在项目里，或设置里关了经验）', true)
      if (!o.experience.record) return text('子任务不记经验：值得记的写进交回的结果，由派你的对话决定', true)
      return reply(
        await o.experience.record({
          id: str(a?.id).trim() || undefined,
          kind: str(a?.kind).trim(),
          title: str(a?.title),
          body: str(a?.body),
          keywords: list(a?.keywords),
          paths: list(a?.paths),
        }),
      )
    },
  },
]
