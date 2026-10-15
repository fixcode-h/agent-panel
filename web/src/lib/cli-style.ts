/** 每种 CLI 的视觉标识；新增 CLI 时补一项即可，缺省走 fallback */
interface CliStyle {
  /** 头像底色渐变 */
  tile: string
  /** 小圆点颜色 */
  dot: string
  /** 文字颜色 */
  text: string
}
const styles: Record<string, CliStyle> = {
  claude: {
    tile: 'from-[#e08a66] to-[#c2593a] shadow-[#d97757]/30',
    dot: 'bg-[#e08a66]',
    text: 'text-[#d97757]',
  },
  codex: {
    tile: 'from-[#2fc192] to-[#0d7a5f] shadow-[#10a37f]/30',
    dot: 'bg-[#2fc192]',
    text: 'text-[#16a37f]',
  },
}
const fallback: CliStyle = { tile: 'from-slate-400 to-slate-600 shadow-slate-500/30', dot: 'bg-slate-400', text: 'text-slate-500' }

export const cliStyle = (id: string) => styles[id] ?? fallback
