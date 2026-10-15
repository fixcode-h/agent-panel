/** 每种 CLI 的标识色；新增 CLI 时补一项即可，缺省走 fallback */
const colors: Record<string, string> = {
  claude: '#c96442',
  codex: '#0e8a6b',
}

export const cliColor = (id: string) => colors[id] ?? '#64748b'
