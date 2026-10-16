import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { resolveLang, setLang } from '../shared/i18n.ts'

/**
 * 服务端的界面语言（返回给页面的错误、写进任务的系统消息）。
 * 不少文案是模块顶层的常量，所以 server/index.ts 第一个引入这里，在其他模块加载前读设置。
 * 不经过 store.ts，免得把用到文案的模块提前加载。
 */
export function applyServerLang(setting?: string) {
  setLang(resolveLang(setting, process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale))
}

const dir = process.env.AGENT_PANEL_DATA ?? path.join(homedir(), '.agent-panel')
let saved: string | undefined
try {
  saved = JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8')).language
} catch {}
applyServerLang(saved)
