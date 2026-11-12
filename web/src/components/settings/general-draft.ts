import type { Settings } from '@shared/schema'

/**
 * 「常规」页的表单草稿（从 pages/SettingsPage.tsx 挪出）。
 * 数字项存输入框里的原文：填错时输入框照样显示用户敲的字，保存时这一项沿用原值（见 generalSettings）。
 * 草稿放在设置页上而不是「常规」分区里：切到别的页再回来，没填完的输入还在，自动保存也要读它。
 */
export interface GeneralDraft {
  timeout: string
  idle: string
  childAsk: string
  presence: string
  childKeep: string
  archiveDays: string
  reclaim: boolean
  resumeRestart: boolean
  bgLimit: string
  largeMB: string
  longPaste: string
  openBrowser: boolean
  requireToken: boolean
  askUserDefault: boolean
  bugAuthor: boolean
  userName: string
  developerMode: boolean
  shell: Settings['shell']
  contentWidth: number
  fileFormat: Settings['fileFormat']
  language: Settings['language']
}

export const toGeneralDraft = (initial: Settings): GeneralDraft => ({
  timeout: String(initial.stepTimeoutMinutes),
  idle: String(initial.idleTimeoutMinutes),
  childAsk: String(initial.childIdleAskMinutes),
  presence: String(initial.presenceGraceMinutes),
  childKeep: String(initial.childDoneKeepMinutes),
  archiveDays: String(initial.autoArchiveDays),
  reclaim: initial.reclaimIdleCli,
  resumeRestart: initial.resumeAfterRestart,
  bgLimit: String(initial.backgroundLimit),
  largeMB: String(initial.largeFileMB),
  longPaste: String(initial.longPasteChars),
  openBrowser: initial.openBrowser,
  requireToken: initial.requireToken,
  askUserDefault: initial.askUserDefault,
  bugAuthor: initial.bugAuthor,
  userName: initial.userName,
  developerMode: initial.developerMode,
  shell: initial.shell,
  contentWidth: initial.contentWidth,
  fileFormat: initial.fileFormat,
  language: initial.language,
})

/** 输入框原文是不是 lo 到 hi 之间的整数 */
const intIn = (text: string, lo: number, hi: number) => {
  const n = Number(text)
  return { n, ok: text !== '' && Number.isInteger(n) && n >= lo && n <= hi }
}

/** 「常规」页每个数字项是否填对：输入框标红和保存时取值都看它 */
export function generalChecks(g: GeneralDraft) {
  return {
    timeout: intIn(g.timeout, 0, 1440),
    idle: intIn(g.idle, 0, 1440),
    childAsk: intIn(g.childAsk, 0, 1440),
    presence: intIn(g.presence, 0, 1440),
    childKeep: intIn(g.childKeep, 0, 1440),
    archive: intIn(g.archiveDays, 0, 3650),
    bg: intIn(g.bgLimit, 1, 64),
    large: intIn(g.largeMB, 1, 50),
    paste: intIn(g.longPaste, 0, 1_000_000),
  }
}

export type GeneralChecks = ReturnType<typeof generalChecks>
