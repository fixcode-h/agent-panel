/** 每种 CLI 的视觉标识；新增 CLI 时补一项即可，缺省走 fallback */
const styles: Record<string, { gradient: string; dot: string }> = {
  claude: { gradient: 'from-[#d97757] to-[#b5502f]', dot: 'bg-[#d97757]' },
  codex: { gradient: 'from-[#10a37f] to-[#0b6e56]', dot: 'bg-[#10a37f]' },
}
const fallback = { gradient: 'from-slate-500 to-slate-700', dot: 'bg-slate-500' }

export const cliStyle = (id: string) => styles[id] ?? fallback
