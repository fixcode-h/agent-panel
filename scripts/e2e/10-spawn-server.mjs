/**
 * 启动器（scripts/e2e/spawn-server.mjs）自己的回归：端口被别的进程占着时必须明确失败。
 *
 * 以前的两种表现都不好：轻则「服务没有启动（等了 60 秒）」，重则健康检查看到 /health 回 ok 就当自己的
 * 服务起来了，假通过之后在第一个 waitFor 上超时。这里人为占住一个端口，断言启动器立刻报端口冲突；
 * 另外再正常启动一次，确认 PORT=0 自报端口和 /health 的 instance 校验这条路是通的。
 *
 * 这个分片不用 harness：它要测的就是启动器，不需要临时数据目录和假项目。
 */
import http from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from './spawn-server.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const tmp = mkdtempSync(path.join(tmpdir(), 'agent-panel-spawn-'))
// 服务启动会读数据目录、CLI 凭据：都指到临时目录，不碰真正的 ~/.agent-panel
const env = {
  AGENT_PANEL_DATA: path.join(tmp, 'data'),
  HOME: path.join(tmp, 'home'),
  USERPROFILE: path.join(tmp, 'home'),
  LANG: 'zh_CN.UTF-8',
}
mkdirSync(env.HOME, { recursive: true })

const problems = []

// 占住一个端口，模拟残留的服务进程（或并行的另一个分片）
const blocker = http.createServer((req, res) => res.end('not agent panel'))
await new Promise((r) => blocker.listen(0, '127.0.0.1', r))
const busy = blocker.address().port

try {
  const started = await startServer({
    root,
    shardName: 'spawn-server',
    env: { ...env, PORT: String(busy) },
    timeoutMs: 30_000,
  })
  started.stop()
  problems.push('端口被占时启动器居然通过了')
} catch (e) {
  const text = String(e?.message ?? e)
  if (/服务没有启动（等了/.test(text)) problems.push(`等到超时才失败，没有立刻提示端口冲突：${text}`)
  else if (!/EADDRINUSE|已被占用/.test(text)) problems.push(`失败原因不清楚：${text}`)
  else console.log(`✓ 端口被占时立刻失败：${text.split('\n')[0]}`)
}
blocker.closeAllConnections()
await new Promise((r) => blocker.close(r))

// 正常路径：端口由服务自己 listen(0) 报回来，/health 回显的就是这个分片的标记
try {
  const started = await startServer({ root, shardName: 'spawn-server', env, timeoutMs: 60_000 })
  const health = await (await fetch(`${started.baseUrl}/health`)).json()
  if (health.instance !== started.instance) problems.push(`启动后 /health 的 instance 不对：${JSON.stringify(health)}`)
  else if (!started.port) problems.push('服务没有上报实际端口')
  else console.log(`✓ 正常启动：端口 ${started.port}，/health 回显本分片的 instance`)
  started.stop()
} catch (e) {
  problems.push(`正常启动失败：${e?.message ?? e}`)
}

try {
  rmSync(tmp, { recursive: true, force: true })
} catch {}

if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`)
  process.exit(1)
}
console.log('[spawn-server] 全部通过')
