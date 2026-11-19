/**
 * 模型正在写的工具入参（JSON 片段一段段到）边收边转成人能读的文字，界面在「正在写」那一行下面实时显示，
 * 像思考过程一样能看到写到哪了（用户 2026-11-19：交诊断报告、建子对话、派子任务时只有一个转圈，像卡住了）。
 *
 * 不等整段 JSON 写完再解析：片段在任何位置断开都行（字符串中间、转义中间、\u 编码中间），
 * 一个字符一个字符地走状态机，所以每段只处理新到的部分（整段重新解析会随长度平方变慢）。
 * 转出来的样子：顶层每个字段另起一段「字段名：值」，嵌套对象的字段缩进一层，数组每项一行「- 」开头，
 * 字符串里的 \n 还原成换行。只用来看，不当成入参用
 */

type Frame = { kind: 'obj' | 'arr'; expectKey: boolean }

export type DraftReader = {
  /** 收一段新的 JSON 片段，返回这段转出来的文字（可能是空串） */
  feed(chunk: string): string
}

export function createDraftReader(): DraftReader {
  const stack: Frame[] = []
  let inString = false
  let isKey = false
  let escape = false
  let hex = ''
  let unicode = false
  let key = ''
  const indent = () => '  '.repeat(Math.max(0, stack.length - 1))

  /** 一个值开始了：在数组里先另起一行写「- 」 */
  const valueStart = () => {
    const top = stack[stack.length - 1]
    return top?.kind === 'arr' ? `\n${indent()}- ` : ''
  }

  const decoded = (c: string) => {
    if (unicode) {
      hex += c
      if (hex.length < 4) return ''
      unicode = false
      const code = parseInt(hex, 16)
      hex = ''
      return Number.isFinite(code) ? String.fromCharCode(code) : ''
    }
    if (escape) {
      escape = false
      if (c === 'u') {
        unicode = true
        return ''
      }
      return ({ n: '\n', t: '\t', r: '', b: '', f: '' } as Record<string, string>)[c] ?? c
    }
    if (c === '\\') {
      escape = true
      return ''
    }
    return c
  }

  const step = (c: string): string => {
    if (inString) {
      if (!escape && !unicode && c === '"') {
        inString = false
        if (!isKey) return ''
        isKey = false
        const k = key
        key = ''
        // 顶层字段之间空一行，嵌套的字段只换行缩进
        return `${stack.length <= 1 ? '\n\n' : '\n'}${indent()}${k}：`
      }
      const s = decoded(c)
      if (isKey) {
        key += s
        return ''
      }
      // 字符串里的换行接着缩进，多行的值还在自己那一层下面
      return stack.length > 1 ? s.replace(/\n/g, `\n${indent()}  `) : s
    }
    const top = stack[stack.length - 1]
    switch (c) {
      case '{': {
        const pre = valueStart()
        stack.push({ kind: 'obj', expectKey: true })
        return pre
      }
      case '[': {
        const pre = valueStart()
        stack.push({ kind: 'arr', expectKey: false })
        return pre
      }
      case '}':
      case ']':
        stack.pop()
        return ''
      case ',':
        if (top?.kind === 'obj') top.expectKey = true
        return ''
      case ':':
        if (top?.kind === 'obj') top.expectKey = false
        return ''
      case '"':
        inString = true
        isKey = top?.kind === 'obj' && top.expectKey
        return isKey ? '' : valueStart()
      default:
        if (/\s/.test(c)) return ''
        // 数字、true / false / null：数组里第一个字符另起一行
        return top?.kind === 'arr' && !/[\w.+-]/.test(prevLiteral) ? valueStart() + c : c
    }
  }

  // 数组里的字面量（数字）连着几个字符，只有第一个字符要另起一行
  let prevLiteral = ''
  return {
    feed(chunk) {
      let out = ''
      for (const c of chunk) {
        const s = step(c)
        prevLiteral = !inString && /[\w.+-]/.test(c) ? c : ''
        out += s
      }
      return out
    },
  }
}

/** 界面上只留最后这么多字：交诊断报告这类入参能写一两万字，整段推给页面没必要 */
export const DRAFT_TEXT_MAX = 4000

/** 太长时只留尾巴，前面写「…」 */
export const draftTail = (text: string) =>
  text.length > DRAFT_TEXT_MAX ? `…${text.slice(text.length - DRAFT_TEXT_MAX)}` : text
