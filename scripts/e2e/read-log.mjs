/**
 * 读假 CLI 写在 `FAKE_CLI_LOG + '.xxx'` 里的 JSONL 记录。
 *
 * 假 CLI 用 appendFileSync 一行一行追加写；提示词大的时候，读的一方可能正好撞上「这一行只写了一半」，
 * JSON.parse 会抛 Unterminated string，整个分片就失败在和断言无关的地方（07-local 实测碰到过）。
 * 所以末尾没写完的行直接丢掉（它本来就不算一条记录），中间行解析不了仍然报错——那说明文件真的坏了。
 * 这不是放宽断言：拿到的每条都仍然是完整记录，只是不再把「还没写完的数据」当成一条。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export function readLog(file) {
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').split('\n')
  // 最后一条有内容的行：只有它可能是「正在写、还没写完」的那一行
  const lastContent = lines.reduce((at, line, i) => (line.trim() ? i : at), -1)
  const rows = []
  lines.forEach((line, i) => {
    const text = line.trim()
    if (!text) return
    try {
      rows.push(JSON.parse(text))
    } catch (e) {
      if (i === lastContent) return
      throw new Error(`${path.basename(file)} 第 ${i + 1} 行不是完整的 JSON（文件坏了，不是还没写完）：${e.message}`)
    }
  })
  return rows
}
