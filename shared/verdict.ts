/**
 * 从验收输出里读结论（也用于条件连线的「结论」）；没写结论时视为通过。
 * 回复语言跟随面板设置（见 prompt-lang.ts），但结论靠固定的说法识别，所以提示词里两种写法都给了：
 * 中文「结论：通过 / 不通过」、英文「Verdict: pass / fail」，回复换成英文也不会丢结论。
 * 单独放一个文件：评审门禁和执行报告也要读结论，不该为这一个函数把整个执行引擎引进来
 */
export function parseVerdict(text: string): 'pass' | 'fail' | '' {
  const all = [...text.matchAll(/结论\s*[:：]\s*\**\s*(不通过|通过)/g)]
  if (all.length) return all.at(-1)![1] === '通过' ? 'pass' : 'fail'
  const en = [...text.matchAll(/verdict\s*[:：]\s*(pass|fail)/gi)]
  if (en.length) return en.at(-1)![1].toLowerCase() === 'pass' ? 'pass' : 'fail'
  return ''
}

/**
 * 读子任务（评审、测试验收）的结论：**先看第一行**（约定把结论写在最前面，输出太长时不会被截掉），首行没有结论再退回全文最后一条。
 * 不直接用 parseVerdict（它取全文最后一条，验收节点的语义要保留）：复看时正文里常见「上一轮的『验收结论：不通过』已改掉」，
 * 取最后一条会把已通过的复看判成不通过。
 */
export function leadVerdict(output: string): 'pass' | 'fail' | '' {
  const first = output.split('\n', 1)[0]?.trim() ?? ''
  return parseVerdict(first) || parseVerdict(output)
}
