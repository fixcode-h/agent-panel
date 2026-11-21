/**
 * 从改动里认出「新增的公开函数」：别的模块能调用的那种（TS 的 export function、UE C++ 的 UFUNCTION 和 XXX_API、
 * Lua 模块表上的函数、Python 顶层的非下划线函数）。
 *
 * 为什么要认：Agent 常在自己这边另写一个已有的函数（用户 2026-11-21 报管家头衔那次，没用现成的
 * GetDecorationActorTopLocation 而另写了一个）。新增公开函数是「该先查有没有现成的」的那一刻：
 * 面板在这时推一句先搜一次（knowledge 推送），评审交接里也据此核对有没有写复用检查。
 * 只认新增的行，不判断好坏，不拦截。语言规则一行一种，新语言只加一行
 */

export interface PublicFnRule {
  lang: string
  /** 认哪些文件（按路径） */
  file: RegExp
  /**
   * 认一行：返回函数名，不是就返回 undefined。prev 是同一文件里上一条新增行（C++ 的 UFUNCTION 宏和声明分两行写）
   */
  match: (line: string, prev: string | undefined) => string | undefined
}

const first = (re: RegExp, line: string) => re.exec(line)?.[1]

// TS / JS：export function、export async function、export default function name、export const name = (...) =>
const TS_FN = /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/
const TS_ARROW =
  /^\s*export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/
// C++：XXX_API 导出的函数声明（不是类：class XXX_API 不算）
const CPP_API = /\b[A-Z][A-Z0-9_]*_API\s+(?!class\b|struct\b)[\w:<>,\s*&]*?\b([A-Za-z_]\w*)\s*\(/
// C++：UFUNCTION 宏下一行的声明，取括号前的名字
const CPP_DECL = /\b([A-Za-z_]\w*)\s*\(/
// Lua：function M.Name( / function M:Name( / M.Name = function(；local function 不算
const LUA_FN = /^\s*function\s+[A-Za-z_][\w.]*[.:]([A-Za-z_]\w*)\s*\(/
const LUA_ASSIGN = /^\s*[A-Za-z_][\w.]*\.([A-Za-z_]\w*)\s*=\s*function\b/
// Python：顶层（不缩进）、不以下划线开头
const PY_FN = /^(?:async\s+)?def\s+([A-Za-z]\w*)\s*\(/

export const PUBLIC_FN_RULES: PublicFnRule[] = [
  {
    lang: 'ts',
    file: /\.(?:[cm]?[jt]sx?)$/i,
    match: (line) => first(TS_FN, line) ?? first(TS_ARROW, line),
  },
  {
    lang: 'cpp',
    file: /\.(?:h|hh|hpp|hxx|inl)$/i,
    match: (line, prev) => {
      if (/^\s*UFUNCTION\s*\(/.test(line)) return undefined
      if (prev && /^\s*UFUNCTION\s*\(/.test(prev)) return first(CPP_DECL, line.replace(/\b[A-Z][A-Z0-9_]*_API\b/, ''))
      return first(CPP_API, line)
    },
  },
  { lang: 'lua', file: /\.lua$/i, match: (line) => first(LUA_FN, line) ?? first(LUA_ASSIGN, line) },
  { lang: 'python', file: /\.py$/i, match: (line) => first(PY_FN, line) },
]

export const publicFnRuleFor = (path: string) => PUBLIC_FN_RULES.find((r) => r.file.test(path))

/** 一个文件里新增的那些行里，认出的公开函数名（按出现顺序、去重） */
export function publicFnsAdded(path: string, added: string[]): string[] {
  const rule = publicFnRuleFor(path)
  if (!rule) return []
  const out: string[] = []
  let prev: string | undefined
  for (const line of added) {
    const name = rule.match(line, prev)
    if (name && !out.includes(name)) out.push(name)
    if (line.trim()) prev = line
  }
  return out
}

export interface AddedPublicFn {
  path: string
  name: string
}

/**
 * 从 unified diff（git diff 的输出）里认出新增的公开函数。
 * 只看「+」行；同一个文件里删掉又加回同名的（改了签名）也算新增，交给调用方按需过滤
 */
export function publicFnsInDiff(diff: string): AddedPublicFn[] {
  const out: AddedPublicFn[] = []
  let path = ''
  let added: string[] = []
  const flush = () => {
    if (path) for (const name of publicFnsAdded(path, added)) out.push({ path, name })
    added = []
  }
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      flush()
      const p = line.slice(4).trim()
      path = p === '/dev/null' ? '' : p.replace(/^b\//, '')
      continue
    }
    if (line.startsWith('diff --git ')) {
      flush()
      path = ''
      continue
    }
    if (line.startsWith('+')) added.push(line.slice(1))
  }
  flush()
  return out
}
