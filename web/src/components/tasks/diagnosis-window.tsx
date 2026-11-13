import { useCallback, useContext, useRef, useState, useSyncExternalStore } from 'react'
import type { Task } from '@shared/schema'
import { PaneNavCtx } from './child-open'
import { DiagnosisDialog } from './DiagnosisDialog'

/** 审阅弹窗要的任务字段：标题和各版报告 */
export type DiagnosisTarget = Pick<Task, 'id' | 'title' | 'bug'> & Partial<Pick<Task, 'messages' | 'changes'>>

/** 任务页右栏里放停靠的诊断报告：右栏给一个页签和一块空的容器，报告用 Portal 画进去 */
export interface DiagnosisRail {
  title: string
  onClose: () => void
  /** 右栏页签里那块容器挂上 / 卸下时交回来 */
  setSlot: (el: HTMLElement | null) => void
  /** 换了一份报告：右栏切回这个页签 */
  key: string
}

/**
 * 停靠在右栏还是弹窗（分析稿 U7）：用户切过一次就记在本机，下次打开报告还是那样。
 * 只有宽屏（xl）有并排的右栏：窄屏一律弹窗，不改记下的偏好
 */
const DOCK_KEY = 'diagnosis-docked'
let dockedPref = (() => {
  try {
    return localStorage.getItem(DOCK_KEY) === '1'
  } catch {
    return false
  }
})()
const dockSubs = new Set<() => void>()
function setDockedPref(v: boolean) {
  dockedPref = v
  try {
    localStorage.setItem(DOCK_KEY, v ? '1' : '0')
  } catch {
    // 隐私模式禁用本地存储时只是不记住，这次打开里照样生效
  }
  for (const f of dockSubs) f()
}
const subscribeDock = (cb: () => void) => {
  dockSubs.add(cb)
  return () => void dockSubs.delete(cb)
}

/** 宽屏（xl）才有并排的右栏：和任务页右栏的断点一致（header-items.tsx 的 wide） */
const WIDE = '(min-width: 80rem)'
function useWide() {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(WIDE)
      m.addEventListener('change', cb)
      return () => m.removeEventListener('change', cb)
    },
    () => window.matchMedia(WIDE).matches,
  )
}

/**
 * 诊断报告审阅弹窗挂在任务页顶层（和后台命令窗口同一个做法）。
 * 以前弹窗挂在打开它的那一行里（运行区的「诊断报告」行、交报告那一行工具调用、子对话行的「查看报告」）：
 * 对话输出完一轮、子任务做完推回结果时，运行区跟着挂到新一段总结下面、交报告那一行收进折叠，
 * 那一行一卸载弹窗就跟着没了，用户正在看、正在标注的报告被关掉。弹窗只该由用户关。
 * live 是任务页这一刻的任务：打开的正好是它自己的报告时，弹窗读最新一份（新一版、状态变化跟着更新）。
 *
 * canDock：这个任务页有并排的右栏（顶层对话页，不是右栏里的子对话）时，报告能停靠到右栏（分析稿 U7），
 * 审方案时能对照对话、点开文件。停靠时报告组件仍挂在这里（只是用 Portal 画进右栏的页签），
 * 在弹窗和右栏之间切换不丢已经写的标注和意见
 */
export function useDiagnosisHost(live?: DiagnosisTarget | null, canDock = false) {
  const [target, setTarget] = useState<DiagnosisTarget | null>(null)
  // 先看哪一份（对话里点某一份报告的卡片）；不传看最新那份
  const [version, setVersion] = useState<number | undefined>()
  // auto 是报告交上来时自动弹：已经开着另一个对话的报告就不顶掉它（用户可能正标注到一半），同一个对话的照常换成新的
  const cur = useRef<DiagnosisTarget | null>(null)
  cur.current = target
  const show = useCallback((task: DiagnosisTarget, auto?: boolean, ver?: number) => {
    const c = cur.current
    if (auto && c && c.id !== task.id) return
    setTarget(task)
    // 自动弹的是新交上来的那份：看最新的
    setVersion(auto ? undefined : ver)
  }, [])
  const pref = useSyncExternalStore(subscribeDock, () => dockedPref)
  const wide = useWide()
  const dockable = canDock && wide
  const docked = dockable && pref
  // 自己没有右栏（右栏里的子对话面板）：外层对话页能停靠时，选了停靠的报告交给它放进右栏
  const outer = useContext(PaneNavCtx)?.diagnosisRail
  const handoff = !canDock && wide ? outer : undefined
  const open = useCallback(
    (task: DiagnosisTarget, auto?: boolean, ver?: number) =>
      handoff && dockedPref ? handoff(task, auto, ver) : show(task, auto, ver),
    [handoff, show],
  )
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const close = useCallback(() => setTarget(null), [])
  const shown = target && live && target.id === live.id ? live : target
  const dialog = shown ? (
    // 换了要看的那一份就重新挂：弹窗只在打开时读一次 version
    <DiagnosisDialog
      key={`${shown.id}:${version ?? ''}`}
      task={shown}
      version={version}
      open
      onOpenChange={(o) => !o && close()}
      dock={{
        docked,
        canDock: dockable || !!handoff,
        toggle: () => {
          setDockedPref(!docked)
          // 交给外层的右栏：这边的弹窗关掉，外层接着打开同一份
          if (!docked && handoff) {
            handoff(shown, false, version)
            setTarget(null)
          }
        },
        slot,
      }}
    />
  ) : null
  const showing = !!target
  const rail: DiagnosisRail | null =
    docked && shown ? { title: shown.title, onClose: close, setSlot, key: `${shown.id}:${version ?? ''}` } : null
  // 任务页把这两个放进 PaneNav，行里的 useDiagnosisWindow 从那里拿
  return {
    open,
    dialog,
    showing,
    rail,
    nav: { diagnosis: open, diagnosisShowing: showing, diagnosisRail: dockable ? show : outer },
  }
}

/**
 * 行里打开诊断报告：在任务页里交给顶层的弹窗（见 useDiagnosisHost），
 * 不在任务页里（独立使用的组件）才退回自己挂一个，dialog 由调用方渲染
 */
export function useDiagnosisWindow(live?: DiagnosisTarget | null) {
  const nav = useContext(PaneNavCtx)
  const local = useDiagnosisHost(live)
  return nav?.diagnosis ? { open: nav.diagnosis, dialog: null, showing: !!nav.diagnosisShowing } : local
}
