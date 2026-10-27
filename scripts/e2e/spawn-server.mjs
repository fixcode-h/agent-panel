/**
 * 端到端测试启动服务进程：比起以前「先探测空闲端口再传给服务」，每一步都落到明确的信号上。
 *
 * 以前的问题：探测端口是 listen(0) 后立刻 close，到真正 spawn 服务监听之间有一段窗口，并行的分片
 * 可能拿到同一个端口；而健康检查只要求 /health 回 `{ok:true}`，端口被残留服务或别的分片占着时
 * 也会当成「自己的服务起来了」，于是假通过，再在第一个 waitFor 上超时（PR #48 的 assist 分片就栽在这里）。
 *
 * 现在：
 * - 端口由服务自己 listen(0) 后从 stdout 报回来（AGENT_PANEL_PORT），探测与监听之间的窗口不存在；
 * - 启动时给服务一个分片唯一的 AGENT_PANEL_INSTANCE，/health 回显它，对不上说明端口上是别的服务，立即失败；
 * - stderr 里出现 EADDRINUSE、「端口已被占用」立即失败，不等健康检查超时；
 * - 服务起来之后意外退出，也立刻让分片失败并打印它的 stderr。
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { cleanTestEnv } from '../lib/test-env.mjs'

// 服务在 PORT=0 时打印的一行：实测端口
const PORT_LINE = /^AGENT_PANEL_PORT (\d+)$/
// 服务自己打印的端口占用提示，以及 Node 的 EADDRINUSE
const BUSY = /EADDRINUSE|已被占用/
// 报错时最多带多少行 stderr，太长没人看
const TAIL_LINES = 40
// 保留的 stderr 行数上限，防止长时间运行的分片攒爆内存
const MAX_LINES = 200

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * tsx 的可执行文件：子对话的 worktree 里没有自己的 node_modules（依赖按项目共用一份放在上级目录，
 * 见 docs/lessons/worktree.md），所以沿上级目录找。找不到时返回当前目录的路径，让 spawn 报原来的错
 */
export function tsxBin(root) {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const bin = path.join(dir, 'node_modules/.bin/tsx')
    if (existsSync(bin)) return bin
    if (path.dirname(dir) === dir) return path.join(root, 'node_modules/.bin/tsx')
  }
}

/**
 * /health 的响应是不是本分片启动的服务回的。是就返回 null，不是就返回给人看的说明。
 * 单靠「有东西回 {ok:true}」不够：端口被残留的服务或并行的分片占着时，健康检查照样通过，
 * 然后第一个 waitFor 才超时（假通过）。
 */
export function describeHealthMismatch(body, instance, port) {
  if (body?.instance === instance) return null
  return (
    `端口 ${port} 上的服务不是这个分片启动的（/health 回显 instance=${JSON.stringify(body?.instance)}，` +
    `期望 ${instance}）：端口被残留的服务进程或并行的分片占着`
  )
}

/**
 * 启动服务并等它真的可用。
 * 返回 { child, port, baseUrl, instance, stop }；起不来时 reject 的 Error 里写清是哪一种（端口被占、启动即退出、超时）。
 * onUnexpectedExit 在服务已经可用之后又退出时调用：分片可以立刻失败，不用等下一个请求超时。
 */
export function startServer({ root, shardName, env = {}, timeoutMs = 60_000, onUnexpectedExit } = {}) {
  const instance = `${shardName}-${randomUUID()}`
  // 默认 0 表示让系统分配端口；测试要人为造端口冲突时可以指定一个已被占用的端口
  const requested = env.PORT === undefined ? '0' : String(env.PORT)
  const child = spawn(tsxBin(root), ['server/index.ts'], {
    cwd: root,
    // 继承来的接口变量（ANTHROPIC_BASE_URL 这类）会改掉 CLI 的接口和账号行为：去掉，测试要的由 env 显式传
    env: { ...cleanTestEnv().env, ...env, PORT: requested, AGENT_PANEL_INSTANCE: instance },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const lines = []
  let port = 0
  let verified = false
  let settled = false
  let stopping = false
  let exited = null

  const tail = () =>
    lines.length
      ? `\n服务 stderr 最后 ${Math.min(lines.length, TAIL_LINES)} 行：\n${lines.slice(-TAIL_LINES).join('\n')}`
      : ''
  const stop = () => {
    // 分片收尾自己关掉的服务不算意外退出，否则会用一个假错误盖掉真实的退出码
    stopping = true
    if (!exited) child.kill()
  }

  return new Promise((resolve, reject) => {
    let timer
    const fail = (message) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stop()
      reject(new Error(message))
    }
    const ok = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    timer = setTimeout(() => {
      fail(
        `服务没有启动（等了 ${Math.round(timeoutMs / 1000)} 秒，端口 ${port || '未上报'}，instance ${instance}）${tail()}`,
      )
    }, timeoutMs)

    /** 连自己的服务做健康检查：连不上继续等（tsx 首次编译要几秒），连上了但标记不对立即失败 */
    const verify = async () => {
      const baseUrl = `http://127.0.0.1:${port}/api`
      for (;;) {
        if (settled || exited) return
        let res
        try {
          // 端口上可能有「接受连接但不回响应」的残留进程：不给超时会挂到总超时，又变成「等了 60 秒」
          res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) })
        } catch {
          await sleep(100)
          continue
        }
        let body
        try {
          body = await res.json()
        } catch {
          return fail(
            `端口 ${port} 上的服务不是 Agent 面板（/health 返回 HTTP ${res.status}，不是 JSON）：` +
              '这个端口被别的进程占着，多半是残留的服务或并行的分片',
          )
        }
        if (body?.instance !== instance) return fail(describeHealthMismatch(body, instance, port) ?? '')
        return ok({ child, port, baseUrl, instance, stop })
      }
    }

    child.on('error', (e) => fail(`启动服务进程失败：${e.message}`))

    // stderr 原样转发（以前是 inherit）：断言失败时能看到服务自己的日志
    let errBuf = ''
    child.stderr.on('data', (d) => {
      errBuf += d.toString()
      const parts = errBuf.split('\n')
      errBuf = parts.pop() ?? ''
      for (const line of parts) {
        lines.push(line)
        if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
        process.stderr.write(`${line}\n`)
        if (BUSY.test(line)) fail(`服务没有启动：端口 ${requested} 已被占用（${line.trim()}）${tail()}`)
      }
    })

    let outBuf = ''
    child.stdout.on('data', (d) => {
      outBuf += d.toString()
      const parts = outBuf.split('\n')
      outBuf = parts.pop() ?? ''
      for (const line of parts) {
        const m = PORT_LINE.exec(line.trim())
        if (!m || verified) continue
        verified = true
        port = Number(m[1])
        void verify()
      }
    })

    child.on('exit', (code, signal) => {
      exited = { code, signal }
      const how = `code=${code}${signal ? `，signal=${signal}` : ''}`
      if (!settled) {
        const busy = BUSY.test(lines.join('\n'))
        fail(
          busy
            ? `服务没有启动：端口 ${requested} 已被占用（EADDRINUSE）${tail()}`
            : `服务启动后就退出了（${how}，端口 ${port || '未上报'}）${tail()}`,
        )
        return
      }
      if (stopping) return
      onUnexpectedExit?.(new Error(`服务意外退出（${how}，端口 ${port}）${tail()}`))
    })

    // 端口行只在服务 listen 成功后才会出现（服务无条件打印实际端口），所以端口冲突时走不到这里
  })
}
