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
/** 设置里的语言：auto 跟随浏览器（服务端跟随系统），解析见 resolveLang */
export type LangSetting = Lang | 'auto'

const DICTS: Record<Lang, Record<string, string> | null> = { zh: null, en: EN }

/**
 * 「自动」按浏览器（服务端按系统）语言选一个现有语言：英文浏览器用 English，其余（中文、法语这类没有的、
 * C.UTF-8 这种看不出的）都用简体中文（用户 2026-11-07 定的）
 */
export function resolveLang(setting: string | undefined, fallback?: string): Lang {
  if (setting === 'zh' || setting === 'en') return setting
  return /^en/i.test(fallback ?? '') ? 'en' : 'zh'
}

/** 「自动」时会选中的语言名，设置里的选项显示成「跟随浏览器 · 简体中文」 */
export function autoLangLabel(fallback?: string): string {
  const id = resolveLang('auto', fallback)
  return LANGS.find((l) => l.id === id)?.label ?? id
}

function detect(): { lang: Lang; auto: boolean } {
  try {
    const ls = (globalThis as { localStorage?: { getItem(key: string): string | null } }).localStorage
    const nav = (globalThis as { navigator?: { language?: string } }).navigator
    if (ls) {
      const setting = ls.getItem('lang') ?? 'auto'
      return { lang: resolveLang(setting, nav?.language), auto: setting !== 'zh' && setting !== 'en' }
    }
  } catch {}
  return { lang: 'zh', auto: false }
}

const detected = detect()
// 模块状态：配置副本，重启时重读
let lang: Lang = detected.lang
// 模块状态：配置副本，重启时重读
let auto = detected.auto
export const getLang = () => lang
/**
 * 设置里选的是不是「自动」。浏览器靠它决定要不要把识别出的语言回报给服务端（web/src/lib/data.tsx）；
 * 交给 Agent 的回复语言不看它，只用解析出来的 lang（shared/prompt-lang.ts）
 */
export const isLangAuto = () => auto
/**
 * 界面语言对应的日期 / 数字格式：所有 toLocale*、Intl.*Format 都传它。
 * 不传的话跟着浏览器走，英文界面配中文系统时会混出两种格式
 */
export const uiLocale = () => (lang === 'en' ? 'en-US' : 'zh-CN')
export function setLang(l: Lang, isAuto = false) {
  lang = l
  auto = isAuto
}

/**
 * 临时换成某种语言算一段文字（同步执行完就换回）：给 Agent 的话固定用中文（提示词不翻译），
 * 可有的句子是和界面共用的（例如子对话状态的原因，复查报告 A3），界面切成英文时不能把英文混进给 Agent 的话
 */
export function inLang<T>(l: Lang, fn: () => T): T {
  const prev = lang
  lang = l
  try {
    return fn()
  } finally {
    lang = prev
  }
}

/** 补充词典：只在某些构建里用到的文案（例如在线演示），不放进主词典 */
export function extendDict(l: Lang, dict: Record<string, string>) {
  const d = DICTS[l]
  if (d) for (const k in dict) d[k] ??= dict[k]
}

/**
 * 带变量的文案算出来的句子 → 原句模板（中文原文）。弹窗按标题记尺寸时用它：
 * 「参数 {p} 关联表格」这类标题每个参数都不一样，按算出来的句子记就永远对不上（用户 2026-11-23）。
 * 只留最近的一批，防止长时间运行越攒越多
 */
// 模块状态：缓存，丢了没事（只影响弹窗尺寸记忆对不对得上）
const TEMPLATES = new Map<string, string>()
const TEMPLATE_CAP = 2000

/** 翻译一句文案；{name} 换成 vars 里的值 */
export function t(zh: string, vars?: Record<string, string | number>): string {
  const s = DICTS[lang]?.[zh] ?? zh
  if (!vars) return s
  const out = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
  if (out !== zh) {
    TEMPLATES.delete(out)
    TEMPLATES.set(out, zh)
    if (TEMPLATES.size > TEMPLATE_CAP) TEMPLATES.delete(TEMPLATES.keys().next().value as string)
  }
  return out
}

/** 一句界面文字的原句模板：经 t() 带变量算出来的给模板，其它原样返回 */
export function templateOf(text: string): string {
  return TEMPLATES.get(text) ?? text
}
