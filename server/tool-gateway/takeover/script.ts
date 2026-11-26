/**
 * 改写用的打印脚本（ADR 0084 第二期）：面板把要补给 Agent 的那段写成一个只打印的 node 脚本，
 * 命令改写成 `node "<脚本>"; <原命令>`。为什么不直接 echo：内容里有引号、换行、中文，bash 和 PowerShell 的转义规则不一样，
 * 写成脚本后命令里只有一个路径，两种外壳都一样跑；node 已经是钩子转发脚本的前提。
 *
 * 放系统临时目录（AGENTS.md：临时文件只放 .tmp/ 或系统临时目录），每次写的时候顺手删掉半小时前的
 */
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'

const KEEP_MS = 30 * 60_000

export const takeoverDir = () => path.join(tmpdir(), 'agent-panel-takeover')

async function sweep(dir: string) {
  const now = Date.now()
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    const p = path.join(dir, f)
    const s = await stat(p).catch(() => undefined)
    if (s && now - s.mtimeMs > KEEP_MS) await rm(p, { force: true }).catch(() => undefined)
  }
}

/** 写好脚本，返回它的路径（正斜杠） */
export async function writePrintScript(text: string, dir = takeoverDir()): Promise<string> {
  await mkdir(dir, { recursive: true })
  void sweep(dir)
  const file = path.join(dir, `${randomUUID()}.mjs`)
  // JSON 字符串本身就是合法的 JS 字符串字面量：内容里有什么都不会被当成代码
  await writeFile(file, `process.stdout.write(${JSON.stringify(`${text}\n\n`)})\n`, 'utf8')
  return file.replace(/\\/g, '/')
}
