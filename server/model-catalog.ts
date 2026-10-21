/**
 * 模型目录接口：
 * - GET  /model-catalog            内置目录 + 用户补充目录，设置里显示补充文件的位置
 * - POST /model-catalog/lookup     模型目录里没有时，让 AI 联网查官方数字，写进 config/models.json
 * - GET  /model-catalog/lookup/:id 查询进度
 *
 * AI 查询按设置里的「AI 创建」CLI 和模型跑，只给只读权限，不执行用户的额外参数。
 */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  DEFAULT_MODEL_CONTEXT,
  DEFAULT_MODEL_MAX_OUTPUT,
  MODEL_TIER_NAMES,
  ModelCatalogEntry,
  normalizeModelId,
  type ModelCatalogInfo,
  type ModelLookupJob,
} from '../shared/model-catalog.ts'
import { API_PROTOCOLS } from '../shared/accounts.ts'
import { getCli } from '../shared/clis.ts'
import { agentRun, cliSettings, defaultCli } from '../shared/settings.ts'
import { extractJson } from '../shared/assist.ts'
import { childEnv } from './exec/process.ts'
import { invokeCli } from './exec/invoke.ts'
import { getSettings } from './settings.ts'
import { AUTO_ANSWER } from './asks.ts'
import { mergedModelCatalog, MODEL_CONFIG_DIR, MODEL_CONFIG_FILE, saveModelEntry } from './model-catalog-store.ts'
import { t } from '../shared/i18n.ts'
import { log } from './log.ts'

const LOOKUP_TIMEOUT = 4 * 60_000

const LookupInput = z.object({
  model: z.string().trim().min(1).max(300),
  protocol: z.enum(API_PROTOCOLS).optional(),
  /** 用哪个 CLI 查；不写用「AI 创建」里设置的 */
  cli: z.string().trim().default(''),
})

type Job = ModelLookupJob & { abort: AbortController; at: number; cli: string }

const lookupCli = (settings: Awaited<ReturnType<typeof getSettings>>, own?: string) => {
  if (own && getCli(own)) return own
  if (settings.assist.cli && getCli(settings.assist.cli)) return settings.assist.cli
  return defaultCli(settings)
}

function promptFor(input: { model: string; protocol?: string }) {
  return `你在维护本机 Agent 面板的模型目录。请联网查 ${input.model} 的官方模型信息。

${
  input.protocol
    ? `当前接口使用的协议是 ${input.protocol}，请优先确认这个模型是否支持该协议。`
    : '请确认这个模型支持哪些接口协议。'
}

可用协议（protocols 字段只能从这些值里选）：
- anthropic（Anthropic Messages，也就是 Claude Code 用的协议）
- openai-responses（OpenAI Responses）
- openai-chat（OpenAI Chat Completions，通用的 Chat 协议）
- gemini（Google Gemini）

需要查清楚：
1. 厂商（vendor）：anthropic、openai、google、deepseek、moonshot、zhipu、alibaba、tencent、xiaomi、bytedance、baidu、minimax、xai、mistral 等
2. 模型类型（type）：flash、pro、max、plus、mini、coder、reasoning、general 这类表示模型能力的词
3. 版本（version）：例如 4、5.5、k3
4. 上下文窗口（context）和最大输出（maxOutput），单位是 token，必须是官方公布的准确数字
5. 可选的思考强度（efforts）和默认思考强度（defaultEffort）：取值只能是 low、medium、high、xhigh、max；
   模型不支持思考时 efforts 写空数组
6. 模型档位（tier）：high 是旗舰、medium 是日常、low 是快速便宜
7. 信息来源（source）：官方文档的地址

只使用官方文档或厂商公布的数字。查不到的项留空，不要编造。最后只输出一个 JSON 对象（放在 \`\`\`json 代码块里）：

\`\`\`json
{
  "vendor": "deepseek",
  "id": "deepseek-v4-flash",
  "label": "DeepSeek V4 Flash",
  "type": "flash",
  "version": "4",
  "protocols": ["openai-chat", "openai-responses"],
  "context": 1000000,
  "maxOutput": 128000,
  "efforts": ["low", "medium", "high"],
  "defaultEffort": "low",
  "tier": "low",
  "source": "https://..."
}
\`\`\``
}

const EFFORT_IDS = ['low', 'medium', 'high', 'xhigh', 'max']

/** AI 可能只写协议简称，统一成目录里的写法 */
const PROTOCOL_ALIASES: Record<string, string> = {
  responses: 'openai-responses',
  'openai-response': 'openai-responses',
  chat: 'openai-chat',
  completions: 'openai-chat',
  'chat-completions': 'openai-chat',
  claude: 'anthropic',
  'claude-code': 'anthropic',
  messages: 'anthropic',
  google: 'gemini',
}

const num = (v: unknown) => {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.round(v)
  if (typeof v === 'string') {
    const n = Number(v.replace(/[,_\s]/g, ''))
    return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined
  }
  return undefined
}

/** AI 返回的 JSON 可能用别的字段名；整理成目录记录，缺的用模型名推断 */
export function normalizeLookup(reply: unknown, model: string, protocol?: string): ModelCatalogEntry {
  const raw = (reply && typeof reply === 'object' ? reply : {}) as Record<string, unknown>
  const info = normalizeModelId(model)
  const rawVendor = String(raw.vendor ?? '')
    .trim()
    .toLowerCase()
  const vendor = (/^(unknown|n\/a|other)?$/.test(rawVendor) ? info.vendor : rawVendor) || 'unknown'
  const rawId = String(raw.id ?? info.canonical ?? info.bare)
    .trim()
    .toLowerCase()
  const id = (rawId.slice(rawId.lastIndexOf('/') + 1) || info.bare).trim()
  const type = String(raw.type ?? raw.modelType ?? [...info.types][0] ?? 'general')
    .trim()
    .toLowerCase()
  const version = String(raw.version ?? info.version.join('.'))
    .trim()
    .replace(/^v/i, '')
  const protocols = Array.isArray(raw.protocols)
    ? raw.protocols
        .map((p) => {
          const id = String(p).trim().toLowerCase()
          return PROTOCOL_ALIASES[id] ?? id
        })
        .filter((p) => (API_PROTOCOLS as readonly string[]).includes(p))
    : []
  if (!protocols.length && protocol && (API_PROTOCOLS as readonly string[]).includes(protocol)) protocols.push(protocol)
  const tier = (MODEL_TIER_NAMES as readonly string[]).includes(String(raw.tier).toLowerCase())
    ? String(raw.tier).toLowerCase()
    : 'medium'
  const aliases = Array.isArray(raw.aliases)
    ? raw.aliases
        .map((a) => String(a).trim())
        .filter(Boolean)
        .slice(0, 8)
    : []
  const efforts = Array.isArray(raw.efforts)
    ? [...new Set(raw.efforts.map((e) => String(e).trim().toLowerCase()).filter((e) => EFFORT_IDS.includes(e)))]
    : ['low', 'medium', 'high']
  const defaultEffort = String(raw.defaultEffort ?? raw.default_effort ?? '')
    .trim()
    .toLowerCase()
  return ModelCatalogEntry.parse({
    vendor,
    id,
    label: String(raw.label ?? raw.name ?? id).trim(),
    type,
    version,
    protocols: protocols.length ? protocols : ['openai-chat'],
    context: num(raw.context ?? raw.contextWindow ?? raw.context_window) ?? DEFAULT_MODEL_CONTEXT,
    maxOutput: num(raw.maxOutput ?? raw.max_output ?? raw.max_output_tokens) ?? DEFAULT_MODEL_MAX_OUTPUT,
    efforts,
    defaultEffort: efforts.includes(defaultEffort) ? defaultEffort : efforts.includes(tier) ? tier : (efforts[0] ?? ''),
    tier,
    aliases,
    source: String(raw.source ?? raw.url ?? '').trim(),
  })
}

export function modelCatalogApi() {
  const jobs = new Map<string, Job>()
  const view = ({ abort: _abort, at: _at, cli: _cli, ...j }: Job): ModelLookupJob => j

  setInterval(() => {
    for (const [id, j] of jobs) if (j.status !== 'running' && Date.now() - j.at > 3600_000) jobs.delete(id)
  }, 10 * 60_000).unref()

  async function run(job: Job) {
    const settings = await getSettings()
    const cli = lookupCli(settings, job.cli)
    const def = getCli(cli)
    if (!def) return fail(job, t('没有可用的 Agent，请先在设置里安装并启用'))
    const cs = cliSettings(settings, cli)
    if (!cs.enabled) return fail(job, t('{cli} 在设置里被停用了', { cli: def.name }))
    const picked = agentRun({ cli, model: settings.assist.model, effort: '' }, settings)
    // 查询只需要读网页，用一个固定的临时工作目录，不留下每次查询的目录
    const cwd = path.join(tmpdir(), 'agent-panel-model-lookup')
    await mkdir(cwd, { recursive: true })
    let errors = ''
    const r = await invokeCli({
      cliId: cli,
      command: cs.command,
      build: {
        model: picked.model,
        effort: picked.effort,
        // 只读：AI 只需要联网查资料，不在用户目录里改东西
        permission: def.readOnly || cs.permission,
        extraArgs: [],
        maxTurns: cs.maxTurns || 60,
      },
      cwd,
      env: childEnv(cs.env),
      input: promptFor(job),
      signal: job.abort.signal,
      timeoutMs: LOOKUP_TIMEOUT,
      askUser: () => false,
      // 查询只读资料：审批请求一律不批准，别让进程停在等用户确认上
      onAsk: (ev) => ev.reply(AUTO_ANSWER),
      onEvent: (ev) => {
        if (ev.type === 'text_delta') job.text = (job.text + ev.text).slice(-8000)
        else if (ev.type === 'text')
          job.text = (job.text ? `${job.text.trimEnd()}\n\n${ev.text}` : ev.text).slice(-8000)
        else if (ev.type === 'error') errors = ev.message
      },
    }).catch((e) => {
      fail(job, (e as Error).message)
      return undefined
    })
    if (!r || job.status === 'failed') return
    if (r.killed === 'stopped') return fail(job, t('已停止'))
    if (r.killed === 'timeout') return fail(job, t('超过 {n} 分钟没有完成，已停止', { n: 4 }))
    if (r.spawnError)
      return fail(
        job,
        t('{error}。请确认已安装 {cli}（{hint}），或在设置里填写路径。', {
          error: r.spawnError,
          cli: def.name,
          hint: def.installHint,
        }),
      )
    if (r.code !== 0)
      return fail(
        job,
        [errors, r.stderr.trim().split('\n').slice(-4).join('\n')].filter(Boolean).join('\n') ||
          t('{cli} 退出码 {code}', { cli: def.name, code: String(r.code) }),
      )
    const ex = extractJson(job.text)
    if (!ex.json) return fail(job, ex.error || t('回复里没有 JSON'))
    try {
      const entry = normalizeLookup(ex.json, job.model, job.protocol)
      await saveModelEntry(entry)
      job.entry = entry
      job.text = ex.rest
      job.status = 'done'
      log.info('models', `已补全模型信息：${entry.vendor}/${entry.id}`, { model: job.model })
    } catch (e) {
      fail(job, t('模型信息格式不对：{error}', { error: (e as Error).message }))
    }
  }

  function fail(job: Job, error: string) {
    job.status = 'failed'
    job.error = error
    job.at = Date.now()
  }

  return new Hono()
    .get('/', async (c) => {
      const settings = await getSettings()
      return c.json({
        entries: await mergedModelCatalog(),
        file: MODEL_CONFIG_FILE,
        dir: MODEL_CONFIG_DIR,
        aiLookup: settings.modelCatalog.aiLookup,
      } satisfies ModelCatalogInfo)
    })
    .post('/lookup', async (c) => {
      const p = LookupInput.safeParse(await c.req.json().catch(() => ({})))
      if (!p.success) return c.json({ error: z.prettifyError(p.error) }, 400)
      const settings = await getSettings()
      if (!settings.modelCatalog.aiLookup)
        return c.json({ error: t('模型信息补全已关闭，请先在「设置 · Agent」里打开') }, 400)
      const input = p.data
      if (input.cli && !getCli(input.cli)) return c.json({ error: t('未知的 Agent：{cli}', { cli: input.cli }) }, 400)
      const job: Job = {
        id: randomUUID(),
        model: input.model,
        protocol: input.protocol,
        status: 'running',
        text: '',
        startedAt: Date.now(),
        abort: new AbortController(),
        at: Date.now(),
        cli: input.cli,
      }
      jobs.set(job.id, job)
      void run(job)
        .catch((e) => fail(job, (e as Error).message))
        .finally(() => (job.at = Date.now()))
      return c.json(view(job), 201)
    })
    .get('/lookup/:id', (c) => {
      const j = jobs.get(c.req.param('id'))
      return j ? c.json(view(j)) : c.json({ error: t('找不到这次查询，可能已过期') }, 404)
    })
    .post('/lookup/:id/stop', (c) => {
      const j = jobs.get(c.req.param('id'))
      if (!j) return c.json({ error: t('找不到这次查询') }, 404)
      j.abort.abort()
      return c.json(view(j))
    })
}
