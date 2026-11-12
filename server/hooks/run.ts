import { spawn } from 'node:child_process'
import { checkOutput, type HookDef, type HookInput, type HookOutput } from '../../shared/hooks/defs.ts'
import { hookScriptFile } from './store.ts'
import { t } from '../../shared/i18n.ts'

/**
 * 跑一个用户钩子（ADR 0049 第二期）：命令钩子用面板自己的 Node 跑脚本，stdin 进统一格式的 JSON；
 * HTTP 钩子 POST 同样的 JSON。超时、退出码非 0、输出不是合法的 JSON 都算出错，交给调用方按 onError 处理。
 * 每次跑都记进最近触发（设置页看得到，排查「为什么拦了 / 为什么没拦」）
 */
export interface HookRun {
  out?: HookOutput
  error?: string
  ms: number
}

/** 最近触发：内存里留 50 条，面板重启后从头记 */
export interface HookTrigger {
  at: string
  hookId: string
  name: string
  event: string
  taskId: string
  result: 'none' | 'block' | 'deny' | 'context' | 'error'
  detail: string
  ms: number
}
const TRIGGERS_MAX = 50
const triggers: HookTrigger[] = []
export const recentTriggers = () => [...triggers].reverse()

export function noteTrigger(t: HookTrigger) {
  triggers.push(t)
  if (triggers.length > TRIGGERS_MAX) triggers.splice(0, triggers.length - TRIGGERS_MAX)
}

/** 标准输出最多收这么多：钩子刷屏也不让面板内存涨上去 */
const OUT_MAX = 64 * 1024

/** 用面板的 Node 跑一个钩子脚本（插件钩子的包内脚本也走这里，见 server/plugins/contrib.ts） */
export function runCommand(
  file: string,
  input: HookInput,
  cwd: string,
  timeoutMs: number,
): Promise<{ text: string; error?: string }> {
  return new Promise((resolve) => {
    let text = ''
    let err = ''
    let done = false
    const child = spawn(process.execPath, [file], { cwd: cwd || undefined, env: process.env, stdio: 'pipe' })
    const finish = (r: { text: string; error?: string }) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ text, error: t('超过 {n} 秒没跑完', { n: Math.round(timeoutMs / 1000) }) })
    }, timeoutMs)
    child.stdout.on('data', (c: Buffer) => {
      if (text.length < OUT_MAX) text += c.toString('utf8')
    })
    child.stderr.on('data', (c: Buffer) => {
      if (err.length < 4000) err += c.toString('utf8')
    })
    child.on('error', (e) => finish({ text, error: e.message }))
    child.on('close', (code) =>
      finish(
        code === 0
          ? { text }
          : {
              text,
              error: `${t('退出码 {code}', { code: String(code) })}${err.trim() ? `：${err.trim().slice(-500)}` : ''}`,
            },
      ),
    )
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(input))
  })
}

async function runHttp(def: Extract<HookDef['action'], { type: 'http' }>, input: HookInput, timeoutMs: number) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  // 请求头的值只引用环境变量：密钥不进钩子定义，也就不会跟着导出、备份出去
  for (const h of def.headers) headers[h.key] = process.env[h.env] ?? ''
  const r = await fetch(def.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = (await r.text()).slice(0, OUT_MAX)
  return r.ok ? { text } : { text, error: `HTTP ${r.status}` }
}

/** script 不为空时跑这段源码（设置页「试跑」还没保存的钩子），否则跑已保存的脚本文件 */
export async function runHook(def: HookDef, input: HookInput, cwd: string, script?: string): Promise<HookRun> {
  const t0 = Date.now()
  const timeoutMs = def.timeoutSec * 1000
  let r: { text: string; error?: string }
  try {
    if (def.action.type === 'http') r = await runHttp(def.action, input, timeoutMs)
    else if (script !== undefined) {
      const { writeFile, mkdtemp, rm } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const path = await import('node:path')
      const dir = await mkdtemp(path.join(tmpdir(), 'agent-panel-hook-'))
      const file = path.join(dir, 'hook.mjs')
      await writeFile(file, script, 'utf8')
      r = await runCommand(file, input, cwd, timeoutMs).finally(() => rm(dir, { recursive: true, force: true }))
    } else r = await runCommand(hookScriptFile(def.id), input, cwd, timeoutMs)
  } catch (e) {
    r = { text: '', error: (e as Error).message }
  }
  const ms = Date.now() - t0
  if (r.error) return { error: r.error, ms }
  const raw = r.text.trim()
  let parsed: unknown
  try {
    parsed = raw ? JSON.parse(raw) : undefined
  } catch {
    return { error: t('输出不是 JSON：{text}', { text: raw.slice(0, 200) }), ms }
  }
  const c = checkOutput(def.event, parsed)
  return 'error' in c ? { error: c.error, ms } : { out: c.out, ms }
}

/** 语法检查：node --check 跑一遍脚本，不执行（保存前的校验用） */
export async function checkSyntax(script: string): Promise<string> {
  const { writeFile, mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-panel-hook-'))
  const file = path.join(dir, 'hook.mjs')
  await writeFile(file, script, 'utf8')
  return new Promise<string>((resolve) => {
    const child = spawn(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')))
    child.on('close', (code) =>
      resolve(code === 0 ? '' : err.replace(new RegExp(file.replace(/[\\.]/g, '\\$&'), 'g'), 'hook.mjs').trim()),
    )
    child.on('error', (e) => resolve(e.message))
  }).finally(() => rm(dir, { recursive: true, force: true }))
}
