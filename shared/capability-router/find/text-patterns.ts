/**
 * 兜底的文本搜索怎么认「声明」：IDEA、VS 都用不了时，面板自己按文本找，声明的行排在引用前面。
 * 只认常见写法，不做语义；认不出的照样作为引用 / 文本命中给出，不会漏
 */
import type { FindLang, FindRequest } from './types.ts'

const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 名字里最后一段（A.B:C、A::B 取 C / B）：文本里按它找 */
export const lastName = (q: string) =>
  q
    .split(/::|[.:]/)
    .filter(Boolean)
    .at(-1) ?? q

/** 这一语言里「声明 name」的写法 */
export function declRe(name: string, lang: FindLang): RegExp {
  const n = esc(name)
  if (lang === 'lua')
    // function a.b:Name(、local function Name(、Name = function(、a.Name = …、local Name =
    return new RegExp(
      `^\\s*(local\\s+)?function\\s+([\\w.]+[.:])?${n}\\s*\\(|^\\s*(local\\s+)?([\\w.]+\\.)?${n}\\s*=(?!=)`,
    )
  if (lang === 'cpp')
    // class / struct / enum Name、返回类型 Name(、Owner::Name(、#define Name、using Name =
    return new RegExp(
      `^\\s*(template\\s*<[^>]*>\\s*)?(class|struct|enum(\\s+class)?|union|namespace)\\s+(\\w+_API\\s+)?${n}\\b|\\b\\w+::${n}\\s*\\(|^\\s*#define\\s+${n}\\b|^\\s*using\\s+${n}\\s*=|^[\\w\\s:*&<>,]*\\b${n}\\s*\\([^;]*\\)\\s*(const)?\\s*(override)?\\s*[{;]?\\s*$`,
    )
  return new RegExp(
    `^\\s*(export\\s+)?(async\\s+)?(function|class|interface|type|enum|def|fn|func|const|let|var|struct)\\s+${n}\\b|^\\s*(local\\s+)?function\\s+([\\w.]+[.:])?${n}\\s*\\(`,
  )
}

/**
 * text 的查询是不是写成了正则：Agent 常把 grep 的习惯带过来（`function.*NewTransform`）。
 * 以前一律按原文找，正则写法永远找不到、却回「没有找到」，Agent 以为真没有（2026-11-26 复盘 P1-7）。
 * 只认明确的正则写法；认成正则时也同时按原文找（arr[0] 这类既像正则又是原文的不会漏）
 */
const REGEX_HINT = /\.[*+]|\\[bdwsBDWS]|\(\?[:=!]|\[\^?[^\]\s]+\]|^\^|\$$|\w\|\w|\\[.()[\]{}|*+?]/
export function looksRegex(q: string) {
  if (!REGEX_HINT.test(q)) return false
  try {
    new RegExp(q)
    return true
  } catch {
    return false
  }
}

/** 文本搜索用的匹配：symbol / refs 按整词找名字，text 按原文（不分大小写）找，写成正则的同时按正则找 */
export function textRe(req: Pick<FindRequest, 'kind' | 'query'>): RegExp {
  if (req.kind === 'text')
    return new RegExp(looksRegex(req.query) ? `(?:${req.query})|${esc(req.query)}` : esc(req.query), 'i')
  return new RegExp(`\\b${esc(lastName(req.query))}\\b`)
}

/** 兜底按语言只看这些扩展名 */
export const LANG_EXT: Record<FindLang, string[] | undefined> = {
  lua: ['lua'],
  cpp: ['h', 'hpp', 'hh', 'hxx', 'inl', 'c', 'cc', 'cpp', 'cxx', 'ipp'],
  other: undefined,
}
