/**
 * 需求原话对照表的读写（2026-11-26 复盘 §5-1，条目结构在 ./need-item.ts）。
 * 起因：用户说「黑屏结束抛事件」，设计推荐了别的时机，实现、评审都没回头对原话，最后才发现走样。
 * 识别需求的节点用 write_state 的 needs 把原话拆成条；之后每个节点做完把这一步涉及的条目标上
 * 落地（写在哪 / 证据）、延期或不做（写理由）。状态只认这个工具调用，不看回复里写了什么（ADR 0041）。
 * write_state 本来就是这次运行的共享状态，对照表是其中有结构的一块，并进去不另加工具（ADR 0067）
 */
import { z } from 'zod'
import type { TaskRun } from '../schema.ts'
import { NEED_STATES, type NeedItem, type NeedState } from './need-item.ts'

/** 条目个数和一句的长度上限：对照表要一眼看完，拆得太碎或抄整段原话都看不出哪条没落地 */
export const NEEDS_MAX = 30
const TEXT_MAX = 200
const NOTE_MAX = 400

/** 工具参数：没有 id 带 text 的是新拆出的一条；有 id 的是给已有条目做标记 */
export const NeedInput = z.object({
  id: z.string().trim().optional(),
  text: z.string().trim().optional(),
  state: z.enum(NEED_STATES).optional(),
  note: z.string().trim().optional(),
})
export type NeedInput = z.infer<typeof NeedInput>

export const needState = (n: NeedItem): NeedState => n.marks.at(-1)?.state ?? 'open'

export function needsSummary(needs: readonly NeedItem[]) {
  const c = { total: needs.length, open: 0, done: 0, deferred: 0, dropped: 0 }
  for (const n of needs) c[needState(n)]++
  return c
}

const STATE_WORD: Record<NeedState, string> = { open: '未落地', done: '已落地', deferred: '延期', dropped: '不做' }

/** 一条写成一行：编号、状态、原话、最近一次是谁标的、写了什么 */
function needLine(n: NeedItem) {
  const m = n.marks.at(-1)
  const last = m ? `（${m.by || '某节点'}：${m.note || STATE_WORD[m.state]}）` : ''
  return `- ${n.id} [${STATE_WORD[needState(n)]}] ${n.text}${last}`
}

/**
 * 写进对照表：一次可以同时新拆几条、标几条。整批校验，有一条不对整批不写，错误写清怎么改
 * （拼错编号、延期不写理由悄悄写进去，比报错更糟）
 */
export function applyNeeds(rec: TaskRun, by: string, raw: unknown, at = new Date().toISOString()) {
  const parsed = z.array(NeedInput).min(1).safeParse(raw)
  if (!parsed.success) return { ok: false, info: `needs 格式不对：${z.prettifyError(parsed.error)}` }
  const known = new Map(rec.needs.map((n) => [n.id, n]))
  const adds: NeedItem[] = []
  const marks: { item: NeedItem; state: NeedState; note: string }[] = []
  let seq = rec.needs.reduce((x, n) => Math.max(x, Number(/^N(\d+)$/.exec(n.id)?.[1] ?? 0)), 0)
  for (const x of parsed.data) {
    const note = (x.note ?? '').slice(0, NOTE_MAX)
    if ((x.state === 'deferred' || x.state === 'dropped') && !note)
      return { ok: false, info: `${x.id || x.text?.slice(0, 20)} 标了${STATE_WORD[x.state]}，note 要写理由` }
    if (!x.id) {
      if (!x.text) return { ok: false, info: '新的一条要写 text（用户的说法，一句话）；给已有条目做标记要写 id' }
      if (x.text.length > TEXT_MAX)
        return { ok: false, info: `「${x.text.slice(0, 20)}…」太长：一条只写一句需求，拆开写` }
      const item: NeedItem = { id: `N${++seq}`, text: x.text, by, marks: [] }
      adds.push(item)
      if (x.state && x.state !== 'open') marks.push({ item, state: x.state, note })
      continue
    }
    const item = known.get(x.id)
    if (!item) return { ok: false, info: `没有 ${x.id} 这一条：现在有 ${[...known.keys()].join('、') || '（还没拆）'}` }
    if (!x.state) return { ok: false, info: `${x.id} 要写 state：done / deferred / dropped（还没做的不用标）` }
    marks.push({ item, state: x.state, note })
  }
  if (rec.needs.length + adds.length > NEEDS_MAX)
    return { ok: false, info: `对照表最多 ${NEEDS_MAX} 条：按用户说的要点合并，不要逐句拆` }
  rec.needs.push(...adds)
  for (const m of marks) m.item.marks.push({ by, state: m.state, note: m.note, at })
  const c = needsSummary(rec.needs)
  const open = rec.needs.filter((n) => needState(n) === 'open').map((n) => n.id)
  return {
    ok: true,
    info:
      `已记下${adds.length ? `，新拆 ${adds.map((n) => n.id).join('、')}` : ''}。共 ${c.total} 条：落地 ${c.done}、延期 ${c.deferred}、不做 ${c.dropped}` +
      (open.length ? `，还没落地 ${open.join('、')}` : ''),
  }
}

/** read_state 里附上的对照表全文 */
export function needsText(needs: readonly NeedItem[]) {
  return needs.length ? `需求对照：\n${needs.map(needLine).join('\n')}` : ''
}

/**
 * 交给节点的对照表：有条目时每个节点都带上，做完这一步把涉及的条目标上。
 * 还没拆的时候不提（只有识别需求的节点在说明里被要求拆），省得每个节点都去拆一遍
 */
export function needsPart(rec: TaskRun | undefined) {
  if (!rec || rec.status !== 'running' || !rec.needs.length) return ''
  return [
    '## 需求对照',
    '用户原话拆成的需求（编号、现在的状态、最近一次标记）：',
    rec.needs.map(needLine).join('\n'),
    '这一步做完、交结果之前，用 write_state 的 needs 把这一步涉及的条目逐条标上：落地写 state=done、note 写落在哪（文件、接口、测试）；延期 deferred、不做 dropped 的 note 写理由。和原话不一致的地方不要标 done。没涉及的不用标。',
  ].join('\n')
}
