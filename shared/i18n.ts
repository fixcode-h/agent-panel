import { EN } from './locales/en.ts'

/**
 * 界面多语言。文案直接用中文原文当键：t('新建任务')、t('共 {n} 个文件', { n })，
 * 中文界面原样返回，其他语言查对应的词典，词典里没有的退回中文，不会显示成空白。
 * 语言在模块加载时就要确定（不少文案是模块顶层的常量），所以浏览器从 localStorage 读，
 * 服务端在 server/lang.ts 里先于其他模块设置。
 */
export const LANGS = [
  { id: 'zh', label: '简体中文' },
  { id: 'en', label: 'English' },
] as const
export type Lang = (typeof LANGS)[number]['id']
/** 设置里的语言：auto 跟随浏览器（服务端跟随系统） */
export type LangSetting = Lang | 'auto'

const DICTS: Record<Lang, Record<string, string> | null> = { zh: null, en: EN }

export function resolveLang(setting: string | undefined, fallback?: string): Lang {
  if (setting === 'zh' || setting === 'en') return setting
  return /^zh/i.test(fallback ?? 'zh') ? 'zh' : 'en'
}

function detect(): Lang {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage
    const nav = (globalThis as { navigator?: { language?: string } }).navigator
    if (ls) return resolveLang(ls.getItem('lang') ?? 'auto', nav?.language)
  } catch {}
  return 'zh'
}

let lang: Lang = detect()
export const getLang = () => lang
export function setLang(l: Lang) {
  lang = l
}

/** 补充词典：只在某些构建里用到的文案（例如在线演示），不放进主词典 */
export function extendDict(l: Lang, dict: Record<string, string>) {
  const d = DICTS[l]
  if (d) for (const k in dict) d[k] ??= dict[k]
}

/** 翻译一句文案；{name} 换成 vars 里的值 */
export function t(zh: string, vars?: Record<string, string | number>): string {
  const s = DICTS[lang]?.[zh] ?? zh
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s
}
