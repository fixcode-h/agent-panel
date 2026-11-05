/**
 * 去掉外面包的 shell，只留真正跑的命令（可能套好几层）：
 * - `bash -lc '…'`、`/bin/sh -c …`（Codex 的命令都这样包一层）
 * - Windows 上的 `"…\\cmd.exe" /c "…"`、`"…\\powershell.exe" -Command '…'`、`pwsh -c …`
 * - `wsl [-d 发行版] [-u 用户] [-e|--exec|--] …`
 * - PowerShell 的调用符 `& …`
 * 对话里显示命令（server/exec/rpc/codex.ts）和钩子按命令前缀比（shared/hook-defs.ts 的 commandSegments）都用这一份：
 * 以前只有显示这边剥，钩子不剥，PowerShell 工具里 `cmd /c git push`、Git Bash 里 `wsl -e git push` 这一段的开头是
 * cmd / wsl，「命令开头是 git push」的守卫和用户钩子都对不上（用户 2026-11-05 问到）
 */
const SHELLS = [
  /^(?:\/bin\/|\/usr\/bin\/)?(?:ba|z)?sh(?:\.exe)?\s+-l?c\s+([\s\S]+)$/,
  /^"?(?:[^"\s]*[\\/])?cmd(?:\.exe)?"?\s+\/[cCkK]\s+([\s\S]+)$/i,
  /^"?(?:[^"\s]*[\\/])?(?:powershell|pwsh)(?:\.exe)?"?(?:\s+-(?:NoProfile|NonInteractive|NoLogo|ExecutionPolicy\s+\S+))*\s+-(?:Command|c)\s+([\s\S]+)$/i,
  /^"?(?:[^"\s]*[\\/])?wsl(?:\.exe)?"?(?:\s+(?:-d|--distribution|-u|--user|--cd)\s+\S+)*(?:\s+(?:-e|--exec|--))?\s+([\s\S]+)$/i,
  /^&\s+([\s\S]+)$/,
]

export function unwrapShell(cmd: unknown) {
  let s = (Array.isArray(cmd) ? cmd.join(' ') : String(cmd ?? '')).trim()
  for (let i = 0; i < 5; i++) {
    const m = SHELLS.map((r) => s.match(r)).find(Boolean)
    if (!m) break
    s = m[1].trim()
    // 去掉整体包着的一层引号
    if (s.length > 1 && (s[0] === '"' || s[0] === "'") && s.endsWith(s[0])) s = s.slice(1, -1)
  }
  // 命令里的路径在 JSON 里转义成了 \\，显示时还原
  return s.replace(/\\\\/g, '\\')
}
