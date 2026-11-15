import { commandSegments } from '../../hooks/defs.ts'

/**
 * 命令里自己打印的退出码（实跑发现的）：模型常把命令写成 `node build.mjs; echo "EXIT=$?"`，整条命令退出码是 0，
 * CLI 报不出失败；有时还把失败的和改对的写在同一条里（`a; echo "first=$?"; B=1 a; echo "second=$?"`）。
 * 这里按命令里 echo 的字样去输出里找对应的数字，还原出每一段的退出码。只认工具的输出，不看模型回复的文字
 */
export interface SegmentExit {
  /** echo 前面的那一段命令 */
  command: string
  code: number
}

const ECHO = /^echo\s+(?:-\w+\s+)?["']?([^"'$\n]*)\$\?/

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 每段命令（后面紧跟着 echo $? 的那几段）的退出码；对不上输出的段不算 */
export function segmentExits(command: string, output: string): SegmentExit[] {
  const segs = commandSegments(command)
  const out: SegmentExit[] = []
  let from = 0
  for (let i = 1; i < segs.length; i++) {
    const m = ECHO.exec(segs[i].trim())
    if (!m) continue
    const prev = segs[i - 1].trim()
    if (!prev || ECHO.test(prev)) continue
    // 输出里按顺序找：同样的字样出现多次时依次对应
    const re = new RegExp(`${escape(m[1].trim())}\\s*(\\d+)`, 'g')
    re.lastIndex = from
    const hit = m[1].trim() ? re.exec(output) : null
    if (!hit) continue
    from = hit.index + hit[0].length
    out.push({ command: prev, code: Number(hit[1]) })
  }
  return out
}
