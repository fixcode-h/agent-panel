/**
 * 后台命令的提醒和结果信：可能卡住、跑了很久、跑完的结果。只管措辞，什么时候发由 server/background.ts 判；
 * 时长都由调用方格式化好（fmtDuration）再传进来
 */

export interface BgNoticeJob {
  name: string
  id: string
  command: string
  /** 已经跑了多久 */
  ran: string
  /** 最近多久没有输出 */
  quiet: string
  /** 最后几行输出（已带开头的换行和代码块），没有为空 */
  out: string
  /** 面板什么时候停掉它的那一句 */
  left: string
}

/** 面板会在什么时候停掉它（接在提醒最后） */
export const bgTimeoutLine = (timeout: string) => `面板会在跑满 ${timeout} 时停掉它。`

/** 最后几行输出，接在命令后面 */
export const bgLastOutput = (last: string) => (last ? `\n最后的输出：\n\`\`\`\n${last}\n\`\`\`` : '')

/** 很久没有输出，可能卡住了 */
export const bgStallNotice = (j: BgNoticeJob) =>
  `【面板】后台命令「${j.name}」（编号 ${j.id}）已经跑了 ${j.ran}，最近 ${j.quiet} 没有任何输出，可能卡住了（下载或解压完了却没退出、在等输入、死锁）。\n命令：${j.command}${j.out}\n先用 check_background 看它现在的状态，再用只读命令核对它该产出的东西（文件、进程）在不在；确认卡住就用 stop_background 停掉，查清原因再重跑。它还在正常干活（只是不输出）就不用管，结果照样会推回来。${j.left}`

/** 跑了很久还没结束；next 是下一次提醒在跑满多久时 */
export const bgSlowNotice = (j: BgNoticeJob, next: string) =>
  `【面板】后台命令「${j.name}」（编号 ${j.id}）已经跑了 ${j.ran}，还没结束（最近一次输出在 ${j.quiet} 前）。\n命令：${j.command}${j.out}\n看一眼进度是否正常：输出一直在重复（反复重试、死循环）或者明显跑偏就用 stop_background 停掉；正常就不用管，结束后结果会推回来，下一次提醒在跑满 ${next} 时。${j.left}`

/**
 * 后台命令跑完的结果信。head 是状态那一行（headText），body 是提炼后的日志；command 为空时不写命令（brief 的只报状态）。
 * 结果回来是新的一轮：界面上这一轮的回复就是最新的总结（上一轮的总结说的还是「在等结果」），所以收尾时要整体重写。
 * 但只能要求「结束这一轮时」再总结：以前写「处理完这个结果后，重新总结整段工作」，模型一收到结果就先写一段总结，
 * 没有工具调用的回复会直接结束这一轮，计划还没做完就停（用户 2026-11-06 报结束前钩子反复拦住，一半紧跟在推回结果之后）
 */
export function bgResultLetter(r: { head: string; changed: boolean; command?: string; body: string }): string {
  const warn = r.changed ? '\n注意：它跑的期间工作目录里的文件被改过，结果可能已经不准，必要时重跑一次。' : ''
  const cmd = r.command ? `\n命令：${r.command}` : ''
  const ask =
    '\n按这个结果接着做，不用先写总结；要结束这一轮时，最后那条回复再重新总结整段工作：现在的结论、验证结果、还在后台跑或还在等的事，不要只说这一条命令。'
  return `【面板】${r.head}${warn}${cmd}${r.body ? `\n${r.body}` : ''}${ask}`
}
