import type { ErrorPrint } from '../schema.ts'
import {
  CANDIDATE_CONVS_MAX,
  CANDIDATE_MAX,
  MISS_MAX,
  type KnowledgeCandidate,
  type ProjectKnowledgeState,
} from './candidate.ts'
import { printKey, printScore } from './match/fingerprint.ts'
import { commandWords } from './match/normalize.ts'
import { commandSegments } from '../hooks/defs.ts'
import { specificPurpose } from './push.ts'

/**
 * 当场捕获（设计稿 4.5，三期）：纯函数，server/hooks/knowledge-capture.ts 和单测共用。
 * 「失败后换了做法才成」是机械判定的：一条命令失败，之后几步里同目的的另一条命令成功——不看模型说了什么（ADR 0041）
 */

/** 只做准备、说明不了目的的命令 */
// 模块状态：常量，加载后不改
const SETUP = new Set(['cd', 'pushd', 'popd', 'export', 'set', 'source', 'setlocal', 'chcp'])
/** 解释器：后面的脚本路径就是命令的目的 */
// 模块状态：常量，加载后不改
const INTERPRETERS = new Set([
  'node',
  'python',
  'python3',
  'py',
  'bash',
  'sh',
  'pwsh',
  'powershell',
  'deno',
  'bun',
  'tsx',
  'ruby',
  'perl',
  'lua',
])
/** 后面跟着「跑哪个」的子命令 */
// 模块状态：常量，加载后不改
const RUNNERS = new Set(['run', 'exec', 'run-script', 'dlx', 'x'])

/** 命令的目的：程序名 + 子命令（第一个不是选项、不像文件的参数），`npx tsc -p a.json` 和 `npx tsc` 是同一件事 */
export function purposeOf(command: string): string {
  // 跳过只换目录、设变量的段（`cd web && npm test` 的目的是 npm test）
  const seg =
    commandSegments(command).find((s) => {
      const w = commandWords(s)
      return w.length && !SETUP.has(w[0])
    }) ?? ''
  const [p, ...rest] = commandWords(seg)
  const args = rest.filter((w) => !w.startsWith('-'))
  // 解释器后面的脚本就是目的（`node scripts/build.mjs`、`python tools/gen.py`），别的程序后面像文件的参数不算
  const script = args[0] && INTERPRETERS.has(p) ? args[0].replaceAll('\\', '/') : ''
  const sub = script || (args[0] && !/[./\\]/.test(args[0]) ? args[0] : '')
  // `npm run lint` 和 `npm run build` 是两件事：run / exec 这类子命令再带上它跑的那个名字
  const what = sub && RUNNERS.has(sub) && args[1] ? args[1] : ''
  return [p, sub, what].filter(Boolean).join(' ')
}

export interface Episode {
  /** 失败的那条、改对后的那条命令原文 */
  failed: string
  fixed: string
  purpose: string
  print: ErrorPrint
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** 同一个坑：报错指纹像，或者目的一样、改对的命令也一样 */
function sameEpisode(c: KnowledgeCandidate, ep: Episode): boolean {
  if (c.origin !== 'episode') return false
  if (c.errors.some((e) => printScore(e, ep.print) > 0)) return true
  return !!ep.purpose && c.commands.includes(ep.purpose) && oneLine(c.fixed) === oneLine(ep.fixed)
}

export const newCandidateId = () => `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/**
 * 记一次「失败后改对」：已有同一个坑的候选就合并（加对话、加次数），没有就新建。
 * recurred：这个坑在另一个对话里又出现了——按 Q2 该自动转正成教训
 */
export function addEpisode(
  state: ProjectKnowledgeState,
  ep: Episode,
  conv: string,
  now: string,
): { next: ProjectKnowledgeState; cand: KnowledgeCandidate; recurred: boolean } {
  const old = state.candidates.find((c) => sameEpisode(c, ep))
  if (old) {
    const recurred = !!conv && !old.convs.includes(conv)
    const cand: KnowledgeCandidate = {
      ...old,
      convs: conv ? [conv, ...old.convs.filter((x) => x !== conv)].slice(0, CANDIDATE_CONVS_MAX) : old.convs,
      count: old.count + 1,
      lastAt: now,
    }
    return { next: { ...state, candidates: state.candidates.map((c) => (c === old ? cand : c)) }, cand, recurred }
  }
  const cand: KnowledgeCandidate = {
    id: newCandidateId(),
    kind: 'lesson',
    origin: 'episode',
    title: clip(`${ep.purpose || '命令'} 失败后改成 ${oneLine(ep.fixed)} 才成`, 120),
    rule: `用 \`${clip(oneLine(ep.fixed), 300)}\``,
    wrong: clip(oneLine(ep.failed), 300),
    cause: ep.print.sample ? clip(`报错：${ep.print.sample}`, 500) : '',
    paths: [],
    tags: [],
    commands: specificPurpose(ep.purpose) ? [ep.purpose] : [],
    errors: ep.print.codes.length || ep.print.words.length ? [ep.print] : [],
    failed: clip(ep.failed, 400),
    fixed: clip(ep.fixed, 400),
    expKind: '',
    body: '',
    keywords: [],
    convs: conv ? [conv] : [],
    count: 1,
    firstAt: now,
    lastAt: now,
  }
  // 满了丢最久没出现的：候选是苗子，旧的不再出现说明不重要
  const kept = [...state.candidates].sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, CANDIDATE_MAX - 1)
  return { next: { ...state, candidates: [cand, ...kept] }, cand, recurred: false }
}

/** 子对话记的知识先放候选（Q2：其余的等用户），同标题的合并 */
export function addSubtaskCandidate(
  state: ProjectKnowledgeState,
  input: Partial<KnowledgeCandidate> & Pick<KnowledgeCandidate, 'kind' | 'title'>,
  conv: string,
  now: string,
): { next: ProjectKnowledgeState; cand: KnowledgeCandidate } {
  const key = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  const old = state.candidates.find((c) => c.kind === input.kind && key(c.title) === key(input.title))
  const base: KnowledgeCandidate = old ?? {
    id: newCandidateId(),
    kind: input.kind,
    origin: 'subtask',
    title: '',
    rule: '',
    wrong: '',
    cause: '',
    paths: [],
    tags: [],
    commands: [],
    errors: [],
    failed: '',
    fixed: '',
    expKind: '',
    body: '',
    keywords: [],
    convs: [],
    count: 0,
    firstAt: now,
    lastAt: now,
  }
  const cand: KnowledgeCandidate = {
    ...base,
    ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== '')),
    id: base.id,
    origin: base.origin,
    convs: conv ? [conv, ...base.convs.filter((x) => x !== conv)].slice(0, CANDIDATE_CONVS_MAX) : base.convs,
    count: base.count + 1,
    lastAt: now,
  }
  const rest = state.candidates.filter((c) => c !== old).slice(0, CANDIDATE_MAX - 1)
  return { next: { ...state, candidates: [cand, ...rest] }, cand }
}

export const dropCandidate = (state: ProjectKnowledgeState, id: string): ProjectKnowledgeState => ({
  ...state,
  candidates: state.candidates.filter((c) => c.id !== id),
})

/** 去掉报错指纹和这条一样的候选（Agent 当场记了、或已经转正了，候选就没用了） */
export function dropByPrint(state: ProjectKnowledgeState, print: ErrorPrint): ProjectKnowledgeState {
  const key = printKey(print)
  return {
    ...state,
    candidates: state.candidates.filter((c) => !c.errors.some((e) => printKey(e) === key || printScore(e, print) > 0)),
  }
}

/** 记一次没配上的查询（搜索词没对上任何经验）：按小写去空白合并 */
export function addMiss(state: ProjectKnowledgeState, query: string, conv: string, now: string): ProjectKnowledgeState {
  const q = oneLine(query).slice(0, 200)
  if (q.length < 3) return state
  const k = q.toLowerCase()
  const old = state.misses.find((m) => m.query.toLowerCase() === k)
  const miss = old
    ? {
        ...old,
        count: old.count + (conv && old.convs.includes(conv) ? 0 : 1),
        convs: conv ? [conv, ...old.convs.filter((x) => x !== conv)].slice(0, CANDIDATE_CONVS_MAX) : old.convs,
        lastAt: now,
      }
    : { query: q, count: 1, convs: conv ? [conv] : [], lastAt: now }
  const rest = state.misses
    .filter((m) => m !== old)
    .sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt))
    .slice(0, MISS_MAX - 1)
  return { ...state, misses: [miss, ...rest] }
}

/** 候选转成记教训的草稿（转正、用户收下都走这里） */
export function candidateLesson(c: KnowledgeCandidate) {
  return {
    title: c.title,
    rule: c.rule,
    cause: c.cause,
    wrong: c.wrong,
    paths: c.paths,
    tags: c.tags,
    triggers: { commands: c.commands, errors: c.errors, intents: [] },
  }
}

/** 当场提示 Agent 记一条（Q1：每轮最多 2 次）：面板已经存好了命令和报错，Agent 只需写规则。发给 Agent 的，不翻译 */
export function episodePrompt(c: KnowledgeCandidate): string {
  return `【面板】刚才 \`${clip(oneLine(c.failed), 120)}\` 失败，改成 \`${clip(oneLine(c.fixed), 120)}\` 后成功了。如果这是这个项目里以后还会踩的坑（不是一次性的笔误），用 knowledge_record 记一条教训：{"kind":"lesson","episode":"${c.id}","title":"一句话规则：该怎么做","rule":"对的做法和为什么"}——命令和报错面板已经存好了，不用再写；不值得记就忽略，继续手上的事。`
}
