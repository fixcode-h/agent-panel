/**
 * 编译报错里「接口没对上」的几类（Agent 写代码能力分析 A4）：不是成员、找不到标识符、参数不对、链接找不到符号。
 * 这几类几乎都是凭记忆写了接口名或签名；模型常见的反应是换个名字再编一次，一次 UE 编译就是几分钟。
 * 面板在编译结果里认出它们时，把涉及的符号列出来，提醒先用代码查找工具或引擎头文件查真实签名再改。
 *
 * 只看编译器的错误码和固定格式，不猜语义；每种写法一行，加一种只加一行。
 * MSVC 按错误码认、从引号里取名字：中文版 VS 的说明是中文（“Foo”: 不是“UBar”的成员），错误码和引号里的名字两种语言都一样。
 * clang（Mac / Linux 上编 UE）没有错误码，按英文说明认
 */

export type CompileHintId = 'not-member' | 'undeclared' | 'args' | 'link'

/** 每一类给模型看的名字和先做什么（一句） */
const KIND: Record<CompileHintId, { label: string; todo: string }> = {
  'not-member': { label: '不是成员', todo: '看那个类型真实有哪些成员（含基类）' },
  undeclared: { label: '找不到标识符', todo: '按名字搜它在哪（含引擎），再看要 include 哪个头' },
  args: { label: '参数不对', todo: '跳到声明看真实参数表' },
  link: { label: '链接找不到符号', todo: '查它在哪个模块，补 Build.cs 依赖；没导出（没有 XXX_API）的换导出的接口' },
}

/**
 * 一种报错写法。pick 说明从错误码后面的引号里怎么取名字：
 * - member：第一段是名字，第二段（不是成员那类才有）是它所在的类型，拼成「类型::名字」
 * - signature：第一段是整段签名（链接报错、C2664），取第一个括号前的函数名
 */
export interface CompileHintRule {
  id: CompileHintId
  re: RegExp
  pick: 'member' | 'signature'
}

export const COMPILE_HINT_RULES: CompileHintRule[] = [
  { id: 'not-member', re: /\berror C2039\b/, pick: 'member' },
  { id: 'not-member', re: /\berror:\s*no member named\b/, pick: 'member' },
  { id: 'undeclared', re: /\berror C(?:3861|2065)\b/, pick: 'member' },
  { id: 'undeclared', re: /\berror:\s*use of undeclared identifier\b/, pick: 'member' },
  { id: 'args', re: /\berror C2660\b/, pick: 'member' },
  { id: 'args', re: /\berror C2664\b/, pick: 'signature' },
  { id: 'args', re: /\berror:\s*no matching (?:member )?function for call to\b/, pick: 'member' },
  { id: 'link', re: /\berror LNK(?:2019|2001)\b/, pick: 'signature' },
  { id: 'link', re: /\bundefined reference to\b/, pick: 'signature' },
]

/** 列多少个符号：前几个最有用，后面多是连锁报错 */
const MAX_SYMBOLS = 8

/** 引号里的一段：英文 'x'、中文 “x”、链接报错的 "x"、ld 的 `x' */
const QUOTED = /['"“`]([^'"”`]+)['"”]/g

/** 错误码（或说明开头）后面的引号里的几段：前面的文件路径里也可能有引号，不算 */
const quoted = (line: string, after: RegExp) => {
  const at = line.search(after)
  return [...line.slice(Math.max(0, at)).matchAll(QUOTED)].map((m) => m[1].replace(/\s+/g, ' ').trim())
}

/** `__declspec(dllimport) public: void __cdecl UFoo::Bar(int)` → `UFoo::Bar`：去掉修饰，取第一个括号前的名字 */
function signatureName(sig: string) {
  const bare = sig.replace(/__declspec\([^)]*\)/g, ' ')
  const m = /([A-Za-z_~][\w:~]*)\s*\(/.exec(bare)
  return m ? m[1] : bare.trim().split(/\s+/).pop() || ''
}

/** clang 的类型写成 'class UBar' */
const typeName = (s: string) => s.replace(/^(?:class|struct|enum)\s+/, '').trim()

export interface CompileHit {
  id: CompileHintId
  label: string
  symbol: string
  todo: string
}

/** 从错误行里认出接口没对上的那几类，按符号去重 */
export function compileHits(errors: string[]): CompileHit[] {
  const out: CompileHit[] = []
  const seen = new Set<string>()
  for (const line of errors) {
    const rule = COMPILE_HINT_RULES.find((r) => r.re.test(line))
    if (!rule) continue
    const parts = quoted(line, rule.re)
    if (!parts.length) continue
    let symbol = signatureName(parts[0])
    if (rule.pick === 'member') {
      const owner = rule.id === 'not-member' && parts[1] ? typeName(parts[1]) : ''
      symbol = owner && !parts[0].includes('::') ? `${owner}::${parts[0]}` : parts[0]
    }
    if (!symbol || seen.has(symbol)) continue
    seen.add(symbol)
    out.push({ id: rule.id, symbol, ...KIND[rule.id] })
    if (out.length >= MAX_SYMBOLS) break
  }
  return out
}

/**
 * 推回给 Agent 的提醒（没有命中返回空）。工具名写的是 UEToVS 的（UE 项目最常接的代码索引），
 * 没接它的项目照「没有就搜头文件」那半句做；UE 插件在新会话开头写了引擎源码在哪
 */
export function compileHintText(errors: string[]): string {
  const hits = compileHits(errors)
  if (!hits.length) return ''
  return [
    '这些报错是接口没对上，先查真实签名再改，不要换个名字或改参数再编一次碰运气：',
    ...hits.map((h) => `- \`${h.symbol}\`（${h.label}）：${h.todo}`),
    '怎么查：接了 UEToVS 用 get_members type_name=<类型> include_inherited=true、search_symbols query=<名字> scope=all、go_to_definition symbol=<类::函数> kind=declaration、suggest_include type=<类型>；没有就用 rg 在引擎或依赖库的头文件里搜（UE 项目的引擎源码目录见开头的「UE C++ 引擎」）。查不到就停下来告诉用户缺什么。',
  ].join('\n')
}
