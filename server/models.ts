import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { CLIS, type CliDefinition } from '../shared/clis.ts'
import type { CliModel, CliModels } from '../shared/schema.ts'
import { cliSettings } from '../shared/settings.ts'
import { capture, childEnv, runProcess } from './exec/process.ts'
import { getSettings } from './settings.ts'

/**
 * 从本机 CLI 读取可用的模型：内置列表跟不上 CLI 的更新，也不知道用户账号能用哪些模型。
 * - Codex：通过 `codex app-server` 的 model/list 请求（和 Codex 自己的 /model 菜单同一个来源）
 * - Command Code：`cmdc --list-models`
 * - Claude Code：没有列出模型的命令，用内置的别名和型号，再加上用户在环境变量、settings.json 里配置的模型
 */

const TTL = 10 * 60_000
const cache = new Map<string, { at: number; data: CliModels }>()

const builtin = (def: CliDefinition): CliModel[] => def.models.map((m) => ({ id: m.id, label: m.label }))

/** 按 id 去重，先出现的优先 */
function uniq(models: CliModel[]) {
  const seen = new Set<string>()
  return models.filter((m) => !seen.has(m.id) && seen.add(m.id))
}

async function codexModels(command: string, env: NodeJS.ProcessEnv): Promise<CliModel[]> {
  const ac = new AbortController()
  let result: CliModel[] | null = null
  let rpcError = ''
  const req = (o: object) => JSON.stringify(o) + '\n'
  const r = await runProcess({
    command,
    args: ['app-server'],
    cwd: homedir(),
    env,
    signal: ac.signal,
    timeoutMs: 20_000,
    keepStdinOpen: true,
    stdin:
      req({ id: 0, method: 'initialize', params: { clientInfo: { name: 'agent-panel', version: '1' } } }) +
      req({ method: 'initialized' }) +
      req({ id: 1, method: 'model/list', params: { limit: 200 } }),
    onLine: (line) => {
      let msg: { id?: number; result?: { data?: unknown[] }; error?: { message?: string } }
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.id !== 1) return
      if (msg.error) rpcError = msg.error.message ?? '未知错误'
      else
        result = (msg.result?.data ?? [])
          .map((x) => x as Record<string, any>)
          .filter((m) => !m.hidden && typeof m.id === 'string')
          .map((m) => ({
            id: m.model || m.id,
            label: m.displayName || m.id,
            description: m.description || undefined,
            efforts: Array.isArray(m.supportedReasoningEfforts)
              ? m.supportedReasoningEfforts.map((e: any) => e.reasoningEffort).filter(Boolean)
              : undefined,
            isDefault: !!m.isDefault || undefined,
          }))
      // 拿到回复就停掉服务
      ac.abort()
    },
  })
  if (result) return result
  if (rpcError) throw new Error(`Codex 返回错误：${rpcError}`)
  if (r.spawnError) throw new Error(r.spawnError)
  if (r.killed === 'timeout') throw new Error('Codex 没有在 20 秒内返回模型列表')
  throw new Error(r.stderr.trim().split('\n').at(-1) || `Codex 退出了（退出码 ${r.code}）`)
}

/** 解析 `cmdc --list-models`：分组标题单独一行，模型行是「id  两个以上空格  说明」 */
export function parseCommandCodeModels(out: string): CliModel[] {
  const models: CliModel[] = []
  let group = ''
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trimEnd()
    // 后面是用法说明和只能在无界面模式用的模型，不是可选的编码模型
    if (/^Pass the full id/i.test(line) || /^Decision models/i.test(line)) break
    if (!line.trim() || /^Available models/i.test(line) || /^Updated /.test(line)) continue
    const m = /^([A-Za-z0-9][\w.\-/:]*)\s{2,}(\S.*)$/.exec(line)
    if (m) {
      const isDefault = /\(default\)/i.test(m[2])
      models.push({
        id: m[1],
        label: m[1],
        description: m[2].replace(/\s*\(default\)\s*/i, ' ').trim(),
        group,
        ...(isDefault && { isDefault }),
      })
    } else if (!/\s{2,}/.test(line) && !line.startsWith(' ')) group = line.trim()
  }
  return models
}

async function commandCodeModels(command: string, env: NodeJS.ProcessEnv): Promise<CliModel[]> {
  const r = await capture(command, ['--list-models'], homedir(), env, 30_000)
  const models = parseCommandCodeModels(r.stdout)
  if (models.length) return models
  if (r.spawnError) throw new Error(r.spawnError)
  throw new Error((r.stderr || r.stdout).trim().split('\n').at(-1) || `退出码 ${r.code}`)
}

/** Claude Code 用户自己配置的模型（第三方网关、固定版本等） */
async function claudeConfigured(env: NodeJS.ProcessEnv): Promise<CliModel[]> {
  const found: CliModel[] = []
  const keys: [string, string][] = [
    ['ANTHROPIC_MODEL', '环境变量 ANTHROPIC_MODEL'],
    ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'opus 对应的模型'],
    ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'sonnet 对应的模型'],
    ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'haiku 对应的模型'],
  ]
  let settingsEnv: Record<string, string> = {}
  try {
    const dir = env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude')
    const s = JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8'))
    settingsEnv = s.env ?? {}
    if (typeof s.model === 'string' && s.model)
      found.push({ id: s.model, label: s.model, description: 'settings.json 里的默认模型' })
  } catch {}
  for (const [k, desc] of keys) {
    const v = env[k] || settingsEnv[k]
    if (v) found.push({ id: v, label: v, description: desc })
  }
  return found
}

export async function cliModels(id: string, refresh = false): Promise<CliModels> {
  const def = CLIS.find((c) => c.id === id)
  if (!def) throw new Error(`未知的 CLI：${id}`)
  const hit = cache.get(id)
  if (!refresh && hit && Date.now() - hit.at < TTL) return hit.data
  const cs = cliSettings(await getSettings(), id)
  const env = childEnv(cs.env)
  let data: CliModels
  try {
    if (id === 'codex') data = { source: 'cli', models: await codexModels(cs.command, env), efforts: [] }
    else if (id === 'commandcode')
      data = { source: 'cli', models: await commandCodeModels(cs.command, env), efforts: [] }
    else data = { source: 'builtin', models: uniq([...builtin(def), ...(await claudeConfigured(env))]), efforts: [] }
  } catch (e) {
    data = { source: 'builtin', models: builtin(def), efforts: [], error: (e as Error).message }
  }
  if (data.source === 'cli' && !data.models.length) data = { source: 'builtin', models: builtin(def), efforts: [] }
  data.models = uniq(data.models)
  data.efforts = [...new Set(data.models.flatMap((m) => m.efforts ?? []))]
  cache.set(id, { at: Date.now(), data })
  return data
}

export const invalidateModels = (id?: string) => (id ? cache.delete(id) : cache.clear())

export function modelsApi() {
  return new Hono().get('/:id/models', async (c) => {
    const id = c.req.param('id')
    if (!CLIS.some((x) => x.id === id)) return c.json({ error: `未知的 CLI：${id}` }, 404)
    return c.json(await cliModels(id, c.req.query('refresh') === '1'))
  })
}
