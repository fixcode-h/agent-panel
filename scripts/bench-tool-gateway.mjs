#!/usr/bin/env node
/**
 * 工具网关的耗时基准（ADR 0083）：
 * 1. 网关自身：几百条样例调用（真实命令样本、读文件、MCP、面板工具）各过一遍「工具前 + 工具后」，
 *    钩子回答是空的（不含守卫、推送），量的是认调用 + 推算改道 + 记录（含追加写 jsonl、推送页面）；
 * 2. 钩子往返：以前不装钩子的类别（读文件、MCP）现在也要过钩子，每次调用多一次往返。
 *    量三种接法各一次往返的时间：CLI 直接 POST（Claude Code 的 HTTP 钩子）、起 curl、起 node 转发脚本。
 *    往返里不含面板的处理（服务端立刻回 {}）。
 *
 * 用法：node scripts/bench-tool-gateway.mjs [条数，默认 500] [往返次数，默认 30]
 * 数据目录用系统临时目录，跑完删掉
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { register } from 'tsx/esm/api'

const N = Number(process.argv[2]) || 500
const TRIPS = Number(process.argv[3]) || 30
const data = mkdtempSync(path.join(tmpdir(), 'agent-panel-bench-'))
process.env.AGENT_PANEL_DATA = data

// 注册一次 tsx 再普通 import：两个模块要共用同一份调用记录（tsImport 每次各开一份模块图）
register()
const { openGateway } = await import('../server/tool-gateway/gateway.ts')
const { recentCalls } = await import('../server/tool-gateway/call-log.ts')

const SAMPLES = [
  ['Bash', 'shell', { command: 'rg -n "OnSellAll" Content/Script' }],
  ['Bash', 'shell', { command: 'git status --short | head -20' }],
  ['Bash', 'shell', { command: 'cd web && npm run test:unit' }],
  ['PowerShell', 'shell', { command: '& "D:/UE_5.4/Engine/Build/BatchFiles/Build.bat" ShopEditor Win64 Development' }],
  ['Bash', 'shell', { command: 'powershell -NoProfile -Command "Select-String -Path src\\*.lua -Pattern \'Sell\'"' }],
  ['Bash', 'shell', { command: 'luac -p Content/Script/UI/Bag.lua' }],
  ['Read', 'read', { file_path: 'Content/Script/UI/BagPanel.lua' }],
  ['Read', 'read', { file_path: 'Content/UI/WBP_Bag.uasset' }],
  ['Grep', 'read', { pattern: 'BagPanel', path: 'Source' }],
  ['Edit', 'edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }],
  ['mcp__idea__lua_code', 'any', { action: 'search', query: 'OnSellAll' }],
  ['mcp__panel__find', 'panel', { action: 'symbol', query: 'OnSellAll' }],
]

const gw = openGateway({
  mode: 'observe',
  task: { id: 'bench', title: '基准' },
  projectId: 'bench',
  cliId: 'claude',
  spec: { searchTools: ['Grep', 'Glob'] },
  claimCtx: async () => ({ customTools: [{ id: 'lua-check', name: 'Lua 检查', sigs: ['luac'] }] }),
})
const onHook = gw.wrap(async () => ({}))

const q = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))]
const fmt = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const avg = s.reduce((a, x) => a + x, 0) / s.length
  return `平均 ${avg.toFixed(3)}ms · 中位 ${q(s, 0.5).toFixed(3)}ms · P95 ${q(s, 0.95).toFixed(3)}ms · 最慢 ${s.at(-1).toFixed(3)}ms`
}

// 先热身（JIT、第一次建目录）不计
for (const [name, kind, input] of SAMPLES)
  await onHook('tool.before', { tool: { kind, name, input, path: String(input.file_path ?? ''), paths: [] } })

const wall = []
for (let i = 0; i < N; i++) {
  const [name, kind, input] = SAMPLES[i % SAMPLES.length]
  const facts = { tool: { kind, name, input: { ...input, i }, path: String(input.file_path ?? ''), paths: [] } }
  const t0 = performance.now()
  await onHook('tool.before', facts)
  await onHook('tool.after', { tool: { ...facts.tool, result: { output: '', failed: false } } })
  wall.push(performance.now() - t0)
}
const recs = recentCalls('bench').slice(0, N)
console.log(`网关自身（记录里的 ms：认调用 + 推算 + 记录，工具前）${N} 条：${fmt(recs.map((r) => r.ms))}`)
console.log(`工具前 + 工具后整段（外面量的，含配对、补记）${N} 条：${fmt(wall)}`)

// 钩子往返：服务端立刻回 {}
const server = createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    res.setHeader('content-type', 'application/json')
    res.end('{}')
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}/hook/tool.before`
const body = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'a.lua' } })

const http = []
for (let i = 0; i < TRIPS; i++) {
  const t0 = performance.now()
  await (await fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json' } })).text()
  http.push(performance.now() - t0)
}
console.log(`钩子往返 · HTTP 直连（Claude Code 的 http 钩子）${TRIPS} 次：${fmt(http)}`)

// 起子进程的两种要在主线程外等：spawnSync 会卡住同一进程里的 HTTP 服务，所以服务放到子进程里跑
server.close()
const child = await import('node:child_process')
const srv = child.spawn(
  process.execPath,
  [
    '-e',
    "const s=require('http').createServer((q,r)=>{q.resume();q.on('end',()=>r.end('{}'))});s.listen(0,'127.0.0.1',()=>console.log(s.address().port))",
  ],
  { stdio: ['ignore', 'pipe', 'inherit'] },
)
const port = await new Promise((r) => srv.stdout.once('data', (d) => r(String(d).trim())))
const url2 = `http://127.0.0.1:${port}/hook/tool.before`

const curl = []
const hasCurl = spawnSync('curl', ['--version']).status === 0
if (hasCurl) {
  for (let i = 0; i < TRIPS; i++) {
    const t0 = performance.now()
    spawnSync('curl', [
      '-s',
      '-f',
      '--max-time',
      '65',
      '-X',
      'POST',
      '-H',
      'content-type: application/json',
      '--data-binary',
      body,
      url2,
    ])
    curl.push(performance.now() - t0)
  }
  console.log(`钩子往返 · 起 curl（命令类钩子、本机有 curl）${TRIPS} 次：${fmt(curl)}`)
} else console.log('钩子往返 · 起 curl：本机没有 curl，跳过')

const fwd = []
const script = `fetch(process.argv[1],{method:'POST',body:process.argv[2]}).then(r=>r.text()).then(t=>process.stdout.write(t))`
for (let i = 0; i < Math.min(TRIPS, 15); i++) {
  const t0 = performance.now()
  spawnSync(process.execPath, ['-e', script, url2, body])
  fwd.push(performance.now() - t0)
}
console.log(`钩子往返 · 起 node 转发脚本（没有 curl 时）${fwd.length} 次：${fmt(fwd)}`)

srv.kill()
rmSync(data, { recursive: true, force: true })
