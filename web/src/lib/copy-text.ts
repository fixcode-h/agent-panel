/**
 * 复制文字到剪贴板。
 *
 * 以前每处各自写一遍 `navigator.clipboard.writeText` + toast，失败时的兜底和文案都不一致：
 * 剪贴板接口要求安全上下文（http 的局域网地址、被嵌在 iframe 里时不可用），那些地方就完全复制不了。
 * 这里统一成一份：先试剪贴板接口，不行退回临时 textarea + execCommand，最后按 opts 提示。
 * 文案（成功、失败）由调用方传入，各处的说法保持原样。
 */
import { toast } from '@/lib/toast'

/** 失败提示：字符串原样弹、函数可以带上底层原因、false 或省略不弹 */
export type CopyFailNotice = false | string | ((error: string) => string)

export interface CopyOptions {
  /** 复制成功后弹的提示；不传就不弹，调用方自己用返回值改按钮状态 */
  done?: string
  /** 复制失败后弹的提示；不传就不弹 */
  fail?: CopyFailNotice
}

/** 复制结果对应的提示文案：不弹时返回 undefined */
export function copyNotice(kind: 'done' | 'fail', options: CopyOptions, error = ''): string | undefined {
  if (kind === 'done') return options.done
  if (options.fail === undefined || options.fail === false) return undefined
  return typeof options.fail === 'function' ? options.fail(error) : options.fail
}

/** 选中一个临时的 textarea 再 execCommand：剪贴板接口不可用时的兜底 */
function legacyCopy(text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  // readonly 防止移动端弹键盘；fixed + 透明让它在原地不引起滚动
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  try {
    return document.execCommand('copy')
  } finally {
    document.body.removeChild(area)
  }
}

/** 复制文字；返回是否真的写进去了（没弹提示的调用方靠它判断） */
export async function copyText(text: string, opts: CopyOptions = {}): Promise<boolean> {
  let error = ''
  try {
    await navigator.clipboard.writeText(text)
  } catch (e) {
    error = (e as Error)?.message ?? ''
    let copied = false
    try {
      copied = legacyCopy(text)
    } catch {
      // 兜底本身也可能不可用（没有 document、浏览器禁用了 execCommand）：按复制失败处理
    }
    if (!copied) {
      const notice = copyNotice('fail', opts, error)
      if (notice) toast.error(notice)
      return false
    }
  }
  const notice = copyNotice('done', opts)
  if (notice) toast.success(notice)
  return true
}
