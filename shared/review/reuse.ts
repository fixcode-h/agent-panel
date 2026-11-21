/**
 * 复用检查写进评审交接单（分析稿 B3）：差异里新增了别的模块能调的公开函数时，派评审的对话在交接单的 reuse 里逐个写
 * 「加了什么、看了哪里有没有现成的、为什么不用现成的」，面板按 shared/code/public-fns.ts 的语言规则表认出新增的公开函数，
 * 有新增而 reuse 没写到的，在评审提示词里标出来，评审可以对这几个名字查一次有没有重复实现。只提示、不拦截。
 *
 * 为什么：#399 要求新建函数时写一行复用检查，但那一行写在回复里，面板不读；评审只看差异、不搜项目，
 * 查不出「已经有一个一样的函数」（用户 2026-11-21 报管家头衔那次，现成的 GetDecorationActorTopLocation 没用上）。
 * 交给 Agent 的话是提示词，不翻译
 */
import { publicFnsInDiff, type AddedPublicFn } from '../code/public-fns.ts'

/** 一个新增函数的复用检查 */
export interface ReuseCheck {
  /** 新增的函数名 */
  added: string
  /** 看了哪里有没有现成的：搜了什么、读了哪个模块的接口 */
  looked: string
  /** 为什么不能直接用现成的 */
  why: string
}

/** 一次最多列这么多新增函数：再多是大重构，逐个查不现实，列前面的就够评审抽查 */
const MAX_FNS = 12

/** 工具参数里的复用检查：模型传什么都可能，认不出的项丢掉 */
export function reuseInput(raw: unknown): ReuseCheck[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => ({
      added: String(x.added ?? '').trim(),
      looked: String(x.looked ?? '').trim(),
      why: String(x.why ?? '').trim(),
    }))
    .filter((x) => x.added)
    .slice(0, 30)
}

/** 新增的公开函数里，reuse 没写到的（按函数名比，大小写不敏感；写了 Class::Name 的也认） */
export function uncheckedFns(fns: AddedPublicFn[], reuse: ReuseCheck[]): AddedPublicFn[] {
  const names = new Set(
    reuse.flatMap((r) => [r.added, r.added.split(/::|\.|:/).at(-1) ?? '']).map((s) => s.toLowerCase()),
  )
  return fns.filter((f) => !names.has(f.name.toLowerCase()))
}

/**
 * 写进评审提示词的一节：交接单写了 reuse 的原样列出，差异里新增了 reuse 没写到的公开函数就标出来，
 * 并允许评审对这几个名字各查一次（评审平时不搜项目，这是只限新增函数名的例外）。都没有时返回空
 */
export function reusePart(diff: string, reuse: ReuseCheck[] = []): string {
  const fns = diff ? publicFnsInDiff(diff) : []
  const left = uncheckedFns(fns, reuse)
  if (!reuse.length && !left.length) return ''
  const rows = reuse.map((r) => `- ${r.added}：看了 ${r.looked || '（没写）'}；不用现成的是因为 ${r.why || '（没写）'}`)
  const miss = left.slice(0, MAX_FNS).map((f) => `- ${f.name}（${f.path}）`)
  const more = left.length > MAX_FNS ? `\n- ……还有 ${left.length - MAX_FNS} 个` : ''
  return [
    '## 新增公开函数的复用检查',
    rows.length ? `派你的对话写的复用检查：\n${rows.join('\n')}` : '',
    left.length
      ? `面板从差异里认出新增公开函数 ${left.length} 个，交接单没写复用检查：\n${miss.join('\n')}${more}`
      : '',
    '这几个函数名你可以各查一次项目里有没有现成的同类实现（有代码查找工具就用它找声明，没有就 `rg -n <名字>`；只限这几个名字，不扩大成全局搜索）。找到已有的、功能一样的，按 🟠 中级报「重复实现」，写清现成的在哪；理由站不住的也照此报。',
  ]
    .filter(Boolean)
    .join('\n\n')
}
