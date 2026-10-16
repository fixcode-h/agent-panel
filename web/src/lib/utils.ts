import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** 按空格拆参数，支持用引号包住含空格的值 */
export const splitArgs = (s: string) =>
  (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((a) => a.replace(/^(["'])(.*)\1$/, '$2'))
export const joinArgs = (a: string[]) => a.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ')

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs))
