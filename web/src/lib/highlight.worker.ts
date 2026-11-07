/**
 * 文件弹窗的整份高亮放在这里算：一百多 KB 的文件高亮要几十到几百毫秒，放主线程上算的时候页面点不动。
 * 收 { id, code, path }，回 { id, lines }（每行的 HTML，认不出语言时 null）
 */
import hljs from 'highlight.js/lib/common'
import { highlightLines } from './file-highlight-core'

self.onmessage = (e: MessageEvent<{ id: number; code: string; path: string }>) => {
  const { id, code, path } = e.data
  let lines = null
  try {
    lines = highlightLines(hljs, code, path)
  } catch {
    // 高亮出错就按纯文本显示，不影响看文件
  }
  postMessage({ id, lines })
}
