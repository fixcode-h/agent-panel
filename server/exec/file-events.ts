/**
 * CLI 报的文件改动（Write、Edit 这类工具调用带的 file 事件）什么时候算数：从 runner.ts 拆出来（它到了行数上限）。
 *
 * 以前调用一报上来就记进改动清单：被钩子拦下（PreToolUse 拒绝）、执行失败的写入也算成改过的文件，
 * 用户报的 Bug 收尾时按改动清单核对方案，一个从没落盘的临时脚本把 submit_merge 一直挡着（2026-11-05）。
 * 现在有结果要等的调用先挂着，结果成功才记；没报失败就结束了的（被打断）照旧记上，宁可多记不能漏掉做了一半的改动。
 * 面板自己的数据目录、系统临时目录里的文件不是项目的改动，不记
 */
import path from 'node:path'
import { tmpdir } from 'node:os'
import type { FileChange, ToolUse } from '../../shared/schema.ts'
import { DATA_DIR } from '../store.ts'

const under = (dir: string, p: string) => {
  const r = path.relative(path.resolve(dir), path.resolve(p))
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r))
}

/**
 * 面板的数据目录（对话目录、附件、Agent 的临时目录）和系统临时目录里、又不在项目目录（cwd）里的文件：不是项目代码。
 * 项目本身放在临时目录下（测试、e2e）时照常算
 */
export function scratchPath(p: string, cwd: string): boolean {
  if (!path.isAbsolute(p) && !/^[A-Za-z]:[\\/]/.test(p)) return false
  if (cwd && under(cwd, p)) return false
  return under(DATA_DIR, p) || under(tmpdir(), p)
}

/** 去掉面板数据目录、临时目录里的文件（收尾核对用） */
export const projectChanges = <T extends Pick<FileChange, 'path'>>(list: T[], cwd: string) =>
  list.filter((c) => !scratchPath(c.path, cwd))

export function createFileEvents(cwd: string, apply: (file: FileChange) => void) {
  const pending = new Map<ToolUse, FileChange>()
  return {
    /** 工具调用带着文件改动：还在等结果的先挂着（waiting 为真），否则按调用本身成没成功马上记 */
    track(tool: ToolUse, file: FileChange | undefined, waiting: boolean) {
      if (!file || scratchPath(file.path, cwd)) return
      if (waiting) pending.set(tool, file)
      else if (!tool.failed) apply(file)
    },
    /** 这次调用有了结果（或这一轮结束还没等到结果）：没失败就记上 */
    settle(tool: ToolUse) {
      const file = pending.get(tool)
      if (!file) return
      pending.delete(tool)
      if (!tool.failed) apply(file)
    },
  }
}
