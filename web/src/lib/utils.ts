import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/** 按空格拆参数，支持用引号包住含空格的值 */
export const splitArgs = (s: string) =>
  (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((a) => a.replace(/^(["'])(.*)\1$/, '$2'))
export const joinArgs = (a: string[]) => a.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ')

/**
 * index.css @theme 里自定义的字号角色（text-caption、text-body…）要告诉 tailwind-merge 是字号：
 * 不登记的话它把 text-caption 当成文字颜色，和后面的 text-subtle 合并时把字号丢掉
 */
export const TEXT_ROLES = [
  'micro',
  'caption',
  'footnote',
  'body',
  'prose',
  'heading',
  'subtitle',
  'title',
  'display',
  'hero',
] as const
const twMerge = extendTailwindMerge({ extend: { theme: { text: [...TEXT_ROLES] } } })

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs))
