import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { resolveLang, setLang } from '../shared/i18n.ts'

/**
 * 服务端的界面语言（返回给页面的错误、写进任务的系统消息）。
 * 不少文案是模块顶层的常量，所以 server/index.ts 第一个引入这里，在其他模块加载前读设置。
 * 不经过 store.ts，免得把用到文案的模块提前加载。
 */
export function applyServerLang(setting?: string, browserLang?: string) {
  // 「自动」先认浏览器回报的识别结果：界面和交给 Agent 的回复语言都按用户看到的那种走，
  // 系统 locale 只是还没打开过页面时的兜底（不是英文的都按简体中文，见 resolveLang）
  setLang(
    resolveLang(setting, browserLang || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale),
    setting !== 'zh' && setting !== 'en',
  )
}

const dir = process.env.AGENT_PANEL_DATA ?? path.join(homedir(), '.agent-panel')
let saved: { language?: string; browserLang?: string } = {}
try {
  saved = JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8')) ?? {}
} catch {}
applyServerLang(saved.language, saved.browserLang)
