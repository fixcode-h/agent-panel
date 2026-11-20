/**
 * 「GitHub 网页」来源：github.com/<o>/<r>/blob/<ref>/<path> 的网页里，文件内容按行放在
 * `<script type="application/json" data-target="react-app.embeddedData">` 的 JSON 里（字段 rawLines）。
 * 外层字段名 GitHub 改过好几次（payload.blob、payload["codeViewBlobLayoutRoute.StyledBlob"]……），
 * 所以不按路径取，递归找第一个 rawLines 字符串数组。文件太大或是二进制时网页上没有内容，返回 null。
 */
const SCRIPT = /<script type="application\/json" data-target="react-app\.embeddedData">([\s\S]*?)<\/script>/

function findLines(o: unknown, depth = 0): string[] | null {
  if (!o || typeof o !== 'object' || depth > 8) return null
  const rec = o as Record<string, unknown>
  const lines = rec.rawLines
  if (Array.isArray(lines) && lines.every((x) => typeof x === 'string')) return lines as string[]
  for (const v of Object.values(rec)) {
    const hit = findLines(v, depth + 1)
    if (hit) return hit
  }
  return null
}

/** 从网页里抽出文件内容；行与行用 \n 连，结尾补一个换行（rawLines 不记最后有没有换行，文本文件绝大多数有） */
export function extractBlobText(html: string): string | null {
  const m = SCRIPT.exec(html)
  if (!m) return null
  let data: unknown
  try {
    data = JSON.parse(m[1])
  } catch {
    return null
  }
  const lines = findLines(data)
  return lines ? `${lines.join('\n')}\n` : null
}
