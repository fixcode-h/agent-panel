import { spawnSync } from 'node:child_process'

/**
 * 本机能不能用 curl：命令类钩子（Codex）有了它就让 curl 直接 POST 到面板，不用每次起 node 跑转发脚本
 *（0.166 实测每次 11–16 ms 对 81–134 ms）。Windows 10 起自带 curl.exe；查一次记住，查不到就照旧用转发脚本
 */
let cached: boolean | undefined // 模块状态：缓存，丢了重算

export function hasCurl(): boolean {
  if (cached !== undefined) return cached
  const r = spawnSync(process.platform === 'win32' ? 'curl.exe' : 'curl', ['--version'], {
    timeout: 5000,
    windowsHide: true,
    stdio: 'ignore',
  })
  cached = r.status === 0
  return cached
}
