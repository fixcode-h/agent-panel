import type { HookDefInput } from '../hooks/defs.ts'
import { t } from '../i18n.ts'
import type { KnowledgeHit, KnowledgeHits } from '../knowledge-hits.ts'
import type { ProjectLesson } from '../schema.ts'
import type { DistillResult, KnowledgeMiss } from './candidate.ts'
import { lessonCommands } from './push.ts'

/**
 * 四期「提炼」（设计稿 7 四期、ADR 0066）：从教训、命中反馈和没配上的查询里机械地挑出值得提炼的条目，
 * 拼成发给项目对话的提示词；真正改 AGENTS.md、模块文档的是那个对话里的 Agent，改动走评审弹窗由用户确认。
 * 挑选只看命中记录和反馈计数（shared/knowledge-hits.ts），不调模型、不看回复文字。
 * 「教训转钩子」直接生成一条项目用户钩子（tool.before 拒绝对得上的命令），不经过模型。
 * 提示词是发给 Agent 的，不翻译；挑不出条目时的说明给人看，用 t()
 */

/** 一次最多提炼几条：多了 Agent 写出来的补丁用户看不过来 */
export const DISTILL_MAX = 12
/** 写进 AGENTS.md 的门槛：被推到的次数、帮上的次数 */
const AGENTS_MIN_HITS = 3
const AGENTS_MIN_HELPED = 2
/** 没配上的查询至少出现几次才值得补经验 */
const MISS_MIN = 2

const hitOf = (hits: KnowledgeHits, id: string): KnowledgeHit =>
  hits[id] ?? { count: 0, lastAt: '', taskIds: [], helped: 0, violated: 0, missed: 0 }

/** 还在推送的教训：停用的、已经提炼过的（promoted）不再提炼 */
const live = (lessons: ProjectLesson[]) => lessons.filter((l) => l.enabled && l.status !== 'promoted')

/** 教训全文一段：给 Agent 看，带 id 和命中反馈 */
function lessonBlock(l: ProjectLesson, h?: KnowledgeHit) {
  return [
    `### [${l.id}] ${l.title}`,
    l.rule && `做法：${l.rule}`,
    l.wrong && `错的做法：${l.wrong}`,
    l.cause && `起因：${l.cause}`,
    l.paths.length && `管的文件：${l.paths.join('、')}`,
    l.triggers.commands.length && `命令：${l.triggers.commands.join('、')}`,
    h && `反馈：推到 ${h.count} 次，帮上 ${h.helped} 次，推了还犯 ${h.violated} 次，事前没推到 ${h.missed} 次`,
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 够格写进 AGENTS.md 的教训：置顶的，或推到 ≥3 次、帮上 ≥2 次的；推了还犯得多的排前面（最该升到每次都读的规则里）
 */
export function pickForAgents(lessons: ProjectLesson[], hits: KnowledgeHits): string[] {
  return live(lessons)
    .filter((l) => {
      const h = hitOf(hits, l.id)
      return l.status === 'pinned' || h.count >= AGENTS_MIN_HITS || h.helped >= AGENTS_MIN_HELPED
    })
    .sort((a, b) => {
      const x = hitOf(hits, a.id)
      const y = hitOf(hits, b.id)
      return y.violated - x.violated || y.count - x.count
    })
    .slice(0, DISTILL_MAX)
    .map((l) => l.id)
}

export function agentsPrompt(projectName: string, lessons: ProjectLesson[], picked: string[], hits: KnowledgeHits) {
  const ls = picked.map((id) => lessons.find((l) => l.id === id)).filter((l): l is ProjectLesson => !!l)
  return `请把「${projectName}」的下面 ${ls.length} 条项目教训提炼进项目的约定文件（AGENTS.md；没有就看 CLAUDE.md，两个都没有就新建 AGENTS.md）。
这些教训被反复用到，写进每次都读的约定文件后就不必再靠面板临时推送。要求：
1. 先读现有的约定文件，已经写了的不重复，同类的合并成一条通用规则；写成「下次直接照做」的规则，不写这次的经过。
2. 只改约定文件这一个文档，不改代码、不改教训文件。改动交给我评审确认。
3. 最后列出每条教训的处理：已写进（写进了哪一节）、已有同类（哪一句）、不适合写进（为什么）。已写进和已有同类的 id 单独列一行「已提炼：id1, id2」，我确认后会把它们标成已提炼、不再推送。

${ls.map((l) => lessonBlock(l, hits[l.id])).join('\n\n')}`
}

/** 管具体文件的教训：按 paths 的第一层目录粗分组，给 Agent 对照模块文档 */
export function pickForDocs(lessons: ProjectLesson[]): string[] {
  return live(lessons)
    .filter((l) => l.paths.length)
    .slice(0, DISTILL_MAX)
    .map((l) => l.id)
}

/** glob 的第一层目录（没有就是「根目录」） */
const topDir = (glob: string) => {
  const seg = glob.replace(/\\/g, '/').replace(/^\.\//, '').split('/')[0] ?? ''
  return !seg || /[*?[]/.test(seg) ? '(根目录)' : seg
}

export function docsPrompt(projectName: string, lessons: ProjectLesson[], picked: string[]) {
  const ls = picked.map((id) => lessons.find((l) => l.id === id)).filter((l): l is ProjectLesson => !!l)
  const groups = new Map<string, ProjectLesson[]>()
  for (const l of ls) {
    const k = topDir(l.paths[0])
    groups.set(k, [...(groups.get(k) ?? []), l])
  }
  return `请把「${projectName}」下面这些管具体文件的项目教训合进对应的模块文档。
1. 先读 docs/MODULE-MAP.md（有的话）和对应模块的 docs/modules/<模块>/README.md，按教训管的文件找到所属模块；下面按第一层目录粗分了组，只是参考。
2. 合进模块文档里讲这块怎么工作、要注意什么的那一节，已经写了的不重复；模块还没有文档就只列出来，不新建。
3. 只改文档，不改代码、不改教训文件。改动交给我评审确认。
4. 最后列出每条的处理，合进去了的 id 单独列一行「已提炼：id1, id2」。

${[...groups].map(([dir, list]) => `## ${dir}\n\n${list.map((l) => lessonBlock(l)).join('\n\n')}`).join('\n\n')}`
}

/**
 * 说明面板自己该改进的条目：事前没推到（missed，触发键缺了或推送规则漏了）、推了还犯（violated，推送没起作用）
 */
export function pickForPanel(lessons: ProjectLesson[], hits: KnowledgeHits): string[] {
  return live(lessons)
    .filter((l) => {
      const h = hitOf(hits, l.id)
      return h.missed >= 1 || h.violated >= 2
    })
    .sort((a, b) => {
      const x = hitOf(hits, a.id)
      const y = hitOf(hits, b.id)
      return y.missed + y.violated - (x.missed + x.violated)
    })
    .slice(0, DISTILL_MAX)
    .map((l) => l.id)
}

export function panelPrompt(projectName: string, lessons: ProjectLesson[], picked: string[], hits: KnowledgeHits) {
  const ls = picked.map((id) => lessons.find((l) => l.id === id)).filter((l): l is ProjectLesson => !!l)
  return `下面是「${projectName}」里推送效果不好的项目教训：有的事前没推到（报错出来才对上），有的推了还是犯。请分析原因，写一份改进建议（markdown）交给我：
- 每条判断是教训本身写得不好（触发命令、管的文件、做法不具体）还是面板的推送时机 / 匹配规则有问题；
- 教训本身的问题给出改写建议（触发命令、管的文件、做法），面板的问题写清楚哪种场景漏了、建议怎么匹配；
- 推了还犯、而且错的做法能用命令认出来的，建议升级成拦截。
只写建议，不改代码、不改教训和文档。

${ls.map((l) => lessonBlock(l, hits[l.id])).join('\n\n')}`
}

/** 没配上、却反复出现的查询：多的在前 */
export function pickMisses(misses: KnowledgeMiss[]): KnowledgeMiss[] {
  return misses
    .filter((m) => m.count >= MISS_MIN && m.query.trim())
    .sort((a, b) => b.count - a.count)
    .slice(0, DISTILL_MAX * 2)
}

export function missesPrompt(projectName: string, misses: KnowledgeMiss[]) {
  return `「${projectName}」里下面这些搜索、查询反复出现，却没有一条项目经验对得上（括号里是出现次数）。请逐个查清楚：要找的东西在哪个目录、代码里叫什么、用什么命令，查到了就用 knowledge_record 记成经验（kind 写 experience，keywords 把这里的说法和代码里的叫法都写上，paths 写真实存在的目录）；查不到或只是一次性的就跳过，最后列出每个查询的处理。
不改代码。

${misses.map((m) => `- ${m.query}（${m.count} 次）`).join('\n')}`
}

/**
 * 拦哪些命令：明确写下的命令触发键，加上标题、错的做法、起因里反引号写的命令。
 * 不取 rule（对的做法）里的命令：那是要 Agent 改用的，拦了就没路可走
 */
export function lessonPrefixes(l: ProjectLesson): string[] {
  const fromText = lessonCommands({ title: l.title, rule: l.wrong, cause: l.cause }).map((w) => w.join(' '))
  const all = [...l.triggers.commands.map((c) => c.trim()), ...fromText]
  return [...new Set(all.filter(Boolean))]
}

/** 钩子脚本：拆段后任一段以前缀开头就拒绝。用户钩子是独立的 Node 脚本，不能 import 面板代码，拆段写在脚本里 */
function hookScript(prefixes: string[], reason: string) {
  return `// 由项目教训生成（知识页「转成钩子」）：命令对得上下面的前缀就拒绝，并告诉模型对的做法
const PREFIXES = ${JSON.stringify(prefixes)}
const REASON = ${JSON.stringify(reason)}
let raw = ''
process.stdin.on('data', (c) => (raw += c)).on('end', () => {
  const input = JSON.parse(raw || '{}')
  const cmd = String(input.tool?.input?.command ?? '')
  const segs = cmd.split(/&&|\\|\\||;|\\||\\n/).map((s) => s.trim().replace(/^["']+|["']+$/g, '').replace(/\\s+/g, ' '))
  if (segs.some((s) => PREFIXES.some((p) => s === p || s.startsWith(p + ' '))))
    process.stdout.write(JSON.stringify({ deny: true, reason: REASON }))
})
`
}

/**
 * 把一条教训转成项目用户钩子：tool.before、只管 shell、只在这个项目里生效。认不出命令的教训转不了，返回 null。
 * 用户在界面上点的，生成即开启（不像 AI 生成的钩子那样默认关着）
 */
export function lessonHook(l: ProjectLesson, projectId: string): HookDefInput | null {
  const prefixes = lessonPrefixes(l)
  if (!prefixes.length) return null
  const reason = [
    `项目教训：${l.title}`,
    l.wrong && `错的做法：${l.wrong}`,
    l.rule && `对的做法：${l.rule}`,
    '照对的做法改了再跑。',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 1500)
  return {
    name: `教训：${l.title}`.slice(0, 60),
    description: `由项目教训 ${l.id} 生成：跑 ${prefixes.join('、')} 时拒绝并给出对的做法`.slice(0, 300),
    event: 'tool.before',
    scope: { projects: [projectId], agents: [], clis: [] },
    // 只有一个前缀时让面板先按前缀筛，不必每条命令都起一次脚本
    match: { tool: 'shell', path: '', command: prefixes.length === 1 ? prefixes[0] : '' },
    action: { type: 'command', script: hookScript(prefixes, reason) },
    enabled: true,
    createdBy: 'user',
  }
}

/** 按请求挑条目、拼提示词；hook 不在这里（要写钩子存储，见 server/knowledge/distill-routes.ts） */
export function distill(
  target: 'agents' | 'docs' | 'panel' | 'misses',
  projectName: string,
  lessons: ProjectLesson[],
  hits: KnowledgeHits,
  misses: KnowledgeMiss[],
): DistillResult {
  if (target === 'misses') {
    const ms = pickMisses(misses)
    if (!ms.length) return { ok: false, info: t('还没有反复出现、又没配上经验的查询') }
    return { ok: true, info: '', title: t('补经验：没配上的查询'), prompt: missesPrompt(projectName, ms), picked: [] }
  }
  const picked =
    target === 'agents'
      ? pickForAgents(lessons, hits)
      : target === 'docs'
        ? pickForDocs(lessons)
        : pickForPanel(lessons, hits)
  if (!picked.length)
    return {
      ok: false,
      info: {
        agents: t('还没有够格写进 AGENTS.md 的教训：置顶，或推到 3 次以上、帮上 2 次以上的才算'),
        docs: t('没有管具体文件的教训可以合进模块文档'),
        panel: t('还没有推送效果不好的教训（事前没推到、推了还犯）'),
      }[target],
    }
  const prompt =
    target === 'agents'
      ? agentsPrompt(projectName, lessons, picked, hits)
      : target === 'docs'
        ? docsPrompt(projectName, lessons, picked)
        : panelPrompt(projectName, lessons, picked, hits)
  const title = {
    agents: t('提炼教训进 AGENTS.md'),
    docs: t('教训合进模块文档'),
    panel: t('面板改进建议'),
  }[target]
  return { ok: true, info: '', title, prompt, picked }
}
