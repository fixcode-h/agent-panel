import { isUeBuildCommand } from '../shared/test-steps.ts'

/**
 * 退出码 0 的后台命令是不是真的跑了：两种明摆着没跑起来的情况按失败算，不报「成功」。
 *
 * 用户 2026-11-12 报：request_build 把编译步骤包成 `cmd.exe /d /c "…"` 交给 Git Bash，MSYS 把 /d /c 改写成路径，
 * cmd 没拿到命令、进了交互模式，打印版本横幅读到输入结束就以 0 退出。面板报「编译成功，310ms」，
 * Agent 和子对话按「编译通过」往下走。根因在 server/step-run.ts 修了，这里兜住同类的「空跑也报成功」。
 * 返回没跑起来的原因（交给 Agent 的提示词，不翻译）；看着正常返回空串
 */
export function notRunReason(command: string, lines: string[], ms: number): string {
  // UTF-16 的输出按 UTF-8 读进来每个字符后面跟一个 \0（显示成字符间的空格）：比较前把空白和 \0 全去掉
  const compact = lines.map((l) => l.replace(/[\0\s]/g, '')).filter(Boolean)
  const banner = (l: string) => /^MicrosoftWindows\[/i.test(l) || /^\(c\)Microsoft/i.test(l)
  const prompt = (l: string) => /^[A-Za-z]:[\\/][^>]*>$/.test(l)
  if (compact.some(banner) && compact.every((l) => banner(l) || prompt(l)))
    return '（面板判定为失败：cmd 只打印了版本横幅就退出，要跑的命令没有交到它手里，什么都没执行。多半是 cmd 的 /c 参数被外层 shell 改写或转义坏了；不要当成功处理）'
  // UE 编译：真编译最少也要启动 UnrealBuildTool（几秒），输出里一定有它的日志
  if (
    isUeBuildCommand(command) &&
    ms < 5000 &&
    !lines.some((l) => /UnrealBuildTool|Target is up to date|Result: Succeeded|Total execution time/i.test(l))
  )
    return '（面板判定为失败：UE 编译几秒内就结束，输出里没有任何 UnrealBuildTool 的日志，编译没有真正跑起来；不要当成编译通过）'
  return ''
}
