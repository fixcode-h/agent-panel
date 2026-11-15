/**
 * knowledge_lookup（设计稿二期）：教训和经验一个入口查。按关键词、要改的文件、标签或 id，
 * 教训给全文（最相关的在前）、经验给答案和位置；两边都没配上时记一次「没配上的查询」（提炼页列出反复没配上的）。
 * 旧的 project_lessons / project_experience 还能用（收进 more_tools，保留一个版本）
 */
import { str, text, type PanelTool } from './types.ts'

const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter((x: string) => x.trim()) : [])
/** 两边都没配上时 find 的回答（面板自己的字样，见 shared/lessons.ts、shared/experience.ts） */
const NONE = /^(这个项目还没有|没有符合条件的|这些文件没有相关的|没有相关的经验)/

export const KNOWLEDGE_LOOKUP: PanelTool = {
  name: 'knowledge_lookup',
  when: (o) => !!o.lessons || !!o.experience,
  def: () => ({
    name: 'knowledge_lookup',
    title: '查项目知识',
    description:
      '查这个项目的教训（以前返工过、被纠正过的规则）和经验（某类东西在哪、叫法对照、命令、验证方法）。动手改文件前传 files 取管这些文件的教训；要全项目搜索或试命令前传 query（用户的说法和代码里的叫法都行）；传 id 取那一条的全文。什么都不传列出全部标题。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，空格分开；或一条教训 / 经验的 id' },
        files: { type: 'array', items: { type: 'string' }, description: '要看或要改的文件、目录，相对项目根' },
        tags: { type: 'array', items: { type: 'string' }, description: '教训标签，带其中任一个的' },
      },
    },
  }),
  call: async (o, a) => {
    if (!o.lessons && !o.experience) return text('这个对话不在项目里，没有项目知识', true)
    const query = str(a?.query).trim()
    const files = list(a?.files)
    const tags = list(a?.tags)
    const lessons = o.lessons ? await o.lessons.find(files, { query, tags }) : ''
    // 只按标签查时经验不参与（经验没有标签）
    const exp = o.experience && (query || files.length || !tags.length) ? await o.experience.find(query, files) : ''
    const miss = (!lessons || NONE.test(lessons)) && (!exp || NONE.test(exp))
    if (miss && query) o.experience?.miss?.(query)
    if (miss)
      return text(
        `没有相关的教训和经验，按正常的办法找。${query ? '找到之后值得记的，用 knowledge_record 记成经验。' : ''}`,
      )
    return text(
      [lessons && !NONE.test(lessons) ? `## 教训\n${lessons}` : '', exp && !NONE.test(exp) ? `## 经验\n${exp}` : '']
        .filter(Boolean)
        .join('\n\n'),
    )
  },
}
