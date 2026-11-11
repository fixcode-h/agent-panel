/**
 * 执行导表脚本：项目设置里配的命令，占位换成这次选中的表格的真实路径，用设置里选的命令行环境逐行执行，
 * 输出一行一行推给页面。一行失败就停下（后面的不再跑），失败原因原样给用户看。
 */
import { stat } from 'node:fs/promises'
import { t } from '../../shared/i18n.ts'
import { exportLines, type ExportEvent, type QuoteStyle } from '../../shared/table-export.ts'
import type { TablesConfig } from '../../shared/tables.ts'
import { runShell } from '../merge-build.ts'
import { currentShell } from '../shells.ts'
import { safeRel, tableFull } from './files.ts'
import { HttpError } from './http-error.ts'

export interface ExportBody {
  /** 第几个导表脚本 */
  script: number
  /** 要导的表格（表格页里的路径） */
  paths: string[]
}

/** WSL 里看 Windows 的盘是 /mnt/<盘符>/… */
const wslPath = (p: string) =>
  p.replace(/^([a-zA-Z]):[\\/]/, (_, d: string) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/')

export async function runExport(
  dir: string,
  cfg: TablesConfig,
  body: ExportBody,
  emit: (e: ExportEvent) => Promise<void> | void,
  signal?: AbortSignal,
) {
  const script = cfg.exports[body.script]
  if (!script) throw new HttpError(t('找不到这个导表脚本，可能刚在项目设置里删了'), 404)
  if (!script.command.trim()) throw new HttpError(t('这个导表脚本还没填命令'))
  if (!body.paths.length) throw new HttpError(t('没有选中表格'))
  const cwd = script.cwd ? tableFull(dir, script.cwd) : dir
  const ok = await stat(cwd)
    .then((x) => x.isDirectory())
    .catch(() => false)
  if (!ok) throw new HttpError(t('导表脚本的执行目录不存在：{dir}', { dir: cwd }))
  const shell = await currentShell()
  const style: QuoteStyle =
    process.platform !== 'win32' || shell?.id === 'wsl' || shell?.id === 'gitbash'
      ? 'sh'
      : shell?.id === 'powershell'
        ? 'powershell'
        : 'cmd'
  const conv = shell?.id === 'wsl' ? wslPath : (p: string) => p
  const targets = body.paths.map((p) => {
    const { rel, full } = safeRel(dir, p, cfg)
    return { file: conv(full), rel }
  })
  const lines = exportLines(script.command, targets, conv(dir), style)
  let failed = false
  for (const [index, line] of lines.entries()) {
    if (signal?.aborted) break
    await emit({ type: 'start', line, index, total: lines.length })
    const r = await runShell(line, cwd, {
      timeoutMs: script.timeoutMin * 60_000,
      signal,
      shell: shell ?? undefined,
      onLine: (text) => void emit({ type: 'out', text }),
      // 进度、警告多写在 stderr：按行拆开和 stdout 混在一起显示
      onStderr: (text) => {
        for (const l of text.split(/\r?\n/)) if (l) void emit({ type: 'out', text: l })
      },
    })
    const bad = r.code !== 0 || !!r.killed || !!r.spawnError
    await emit({
      type: 'end',
      index,
      code: r.code,
      killed: r.killed ?? undefined,
      error: r.spawnError,
    })
    if (bad) {
      failed = true
      break
    }
  }
  await emit({ type: 'done', ok: !failed && !signal?.aborted })
}
