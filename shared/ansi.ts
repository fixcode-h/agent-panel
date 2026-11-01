/**
 * 清掉 CLI 输出里的终端控制序列。
 *
 * CLI 发现 stdout 是终端就会上色（`cmdc login` 打印的「Already logged in」带 ESC[32m）。
 * 面板把这段输出显示在网页的 <pre> 里，还要交给「AI 处理」排查；浏览器不认识 ESC 只会把它吞掉，
 * 留下 `[32m` 这种残码。所以在服务端存进 `job.output` 之前就清干净，界面、报错文案、AI 拿到的是同一份干净文本。
 *
 * 只清真正的转义序列，不动普通文本：`[32m` 前面没有 ESC 的（例如 CLI 输出里的 Markdown 链接 `[文字]`）
 * 必须原样保留。
 */

/**
 * CSI：参数 0x30–0x3F、中间 0x20–0x2F、结尾 0x40–0x7E，SGR 颜色和加粗、清屏、光标移动都在这里。
 * 两种引导写法：ESC 加 `[`（7 位，CLI 输出里最常见），和单个 0x9B（8 位，自己带引导、后面**不跟** `[`）。
 */
// oxlint-disable-next-line no-control-regex -- 故意匹配控制字符（ANSI 转义序列、不可见字符）
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]/g

/** OSC（ESC 加 `]` 开头，以 BEL 或 ESC 加反斜杠结尾）：窗口标题、超链接 */
// oxlint-disable-next-line no-control-regex -- 故意匹配控制字符（ANSI 转义序列、不可见字符）
const OSC = /\u001b\][\s\S]*?(?:\u0007|\u001b\x5c)/g

/** 其他转义：带单个字符集的 ESC ( B，以及没有参数的控制（ESC =、ESC 7） */
// oxlint-disable-next-line no-control-regex -- 故意匹配控制字符（ANSI 转义序列、不可见字符）
const SHORT = /\u001b[()#%][0-9A-Za-z]|\u001b[=<>78DEHMNOZ\x5c]/g

/** 清掉 ANSI 转义序列；进度条用回车回到行首，网页里会显示成方块，一并去掉 */
export function stripAnsi(text: string): string {
  return text.replace(OSC, '').replace(CSI, '').replace(SHORT, '').replace(/\r\n/g, '\n').replace(/\r/g, '')
}
