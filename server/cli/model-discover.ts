/**
 * 联网检查新模型（shared/models/discover.ts，契约在 shared/api-contract/model-catalog.ts）：
 * - POST /model-catalog/discover            起一次查询，马上返回编号
 * - GET  /model-catalog/discover/:id        查进度和结果
 * - POST /model-catalog/discover/:id/stop   停掉
 * - POST /model-catalog/entries             用户勾选的候选写进补充目录
 * - POST /model-catalog/entries/remove      删一条补充记录
 *
 * 只在用户点按钮时联网，查到的模型不自动写入：Agent 列的数字可能不准，由用户看过再加。
 */
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { z } from 'zod'
import { modelCatalogContract as M } from '../../shared/api-contract/model-catalog.ts'
import type { ModelCatalogEntry } from '../../shared/models/catalog.ts'
import { newModelCandidates, type ModelDiscoverJob } from '../../shared/models/discover.ts'
import { extractJson } from '../../shared/assist.ts'
import { t } from '../../shared/i18n.ts'
import { log } from '../log.ts'
import { runCatalogAgent } from './model-agent-run.ts'
import { normalizeLookup } from './model-catalog.ts'
import { mergedModelCatalog, removeModelEntry, saveModelEntries } from './model-catalog-store.ts'

/** 要查十几家的文档，比补全单个模型给的时间长 */
const DISCOVER_MINUTES = 12

/** 厂商和去哪查：给 Agent 一个起点，免得它只看第三方汇总站 */
const VENDOR_DOCS: [string, string][] = [
  ['anthropic', 'Anthropic Claude（platform.claude.com 的 models overview）'],
  ['openai', 'OpenAI（developers.openai.com 的 models 和 changelog）'],
  ['google', 'Google Gemini（ai.google.dev 的 models）'],
  ['deepseek', 'DeepSeek（api-docs.deepseek.com 的 Models & Pricing）'],
  ['moonshot', '月之暗面 Kimi（platform.moonshot.cn 的模型列表）'],
  ['zhipu', '智谱 GLM（docs.bigmodel.cn 的模型概览）'],
  ['alibaba', '阿里通义千问（help.aliyun.com 百炼的「模型上架与更新」）'],
  ['tencent', '腾讯混元（hunyuan.tencent.com、腾讯云文档）'],
  ['xiaomi', '小米 MiMo（mimo.mi.com 的模型列表）'],
  ['bytedance', '字节豆包 Seed（火山方舟 ark.volcengine.com 的模型列表）'],
  ['baidu', '百度文心 ERNIE（千帆文档）'],
  ['minimax', 'MiniMax（platform.minimax.cn 的模型发布记录）'],
  ['xai', 'xAI Grok（docs.x.ai 的 release notes）'],
  ['mistral', 'Mistral（docs.mistral.ai 的 changelog）'],
]

export function discoverPrompt(known: ModelCatalogEntry[], today: string) {
  const byVendor = new Map<string, string[]>()
  for (const m of known) byVendor.set(m.vendor, [...(byVendor.get(m.vendor) ?? []), m.id])
  const lines = VENDOR_DOCS.map(
    ([v, where]) => `- ${v}：${where}；目录里已有：${(byVendor.get(v) ?? []).join('、') || '（无）'}`,
  )
  return `你在维护本机 Agent 面板的模型目录。今天是 ${today}。请联网查下面每个厂商的官方文档，找出现在已经能通过 API 调用、但目录里还没有的对话 / 编程模型。

${lines.join('\n')}

要求：
1. 只要文本对话、编程、推理模型；图片、视频、语音、向量、重排、翻译、审核模型都不要。
2. 只要厂商已经开放 API 的；只发布了权重、只在自家 App 里能用、还没上线 API 的不要。
3. 和目录里已有的只差日期后缀、-preview、-latest 的算同一个，不要列。
4. 数字只用官方文档或厂商公布的，查不到的项不要写，不要编造；每条都写 source（官方文档地址）。
5. 字段和取值：
   - vendor：上面列的厂商 id
   - id：调用 API 时 model 参数填的名字，不带 provider/ 前缀
   - label、type（flash、pro、max、plus、mini、lite、coder、reasoning、general 这类）、version（例如 4、5.5、k3）
   - protocols：只能从 anthropic、openai-responses、openai-chat 里选
   - context、maxOutput：token 数
   - efforts：只能从 low、medium、high、xhigh、max 里选；不支持思考写空数组。defaultEffort 写默认那档
   - tier：high 旗舰、medium 日常、low 快速便宜
   - images：能不能看图片
6. 最多列 30 个，按厂商排列，同厂商新的在前。没有新模型就输出空数组。

先用几句话说明查了哪些文档、各家有什么变化（例如哪些旧模型已经下线），最后只输出一个 JSON 对象（放在 \`\`\`json 代码块里）：

\`\`\`json
{
  "models": [
    {
      "vendor": "deepseek",
      "id": "deepseek-flash",
      "label": "DeepSeek V4.1 Flash",
      "type": "flash",
      "version": "4.1",
      "protocols": ["openai-chat", "anthropic"],
      "context": 1000000,
      "maxOutput": 384000,
      "efforts": ["low", "high", "max"],
      "defaultEffort": "high",
      "tier": "low",
      "images": true,
      "source": "https://..."
    }
  ]
}
\`\`\``
}

/** Agent 回的 JSON 整理成目录记录；单条格式不对的跳过，不让一条坏的拖垮整次查询 */
export function parseDiscovered(json: unknown): ModelCatalogEntry[] {
  const list = Array.isArray(json) ? json : (json as { models?: unknown } | null)?.models
  if (!Array.isArray(list)) throw new Error(t('回复里没有 models 列表'))
  return list.flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || !String((raw as { id?: unknown }).id ?? '').trim()) return []
    try {
      const entry = normalizeLookup(raw, String((raw as { id: unknown }).id))
      // 看不看图片按 Agent 查到的写；没写就不写，和内置目录里没登记的一样按不支持处理
      const images = (raw as { images?: unknown }).images
      return [typeof images === 'boolean' ? { ...entry, images } : entry]
    } catch {
      return []
    }
  })
}

type Job = ModelDiscoverJob & { abort: AbortController; at: number; cli: string }

export function modelDiscoverApi() {
  const jobs = new Map<string, Job>()
  const view = ({ abort: _abort, at: _at, cli: _cli, ...j }: Job): ModelDiscoverJob => j
  const fail = (job: Job, error: string) => {
    job.status = 'failed'
    job.error = error
    job.at = Date.now()
  }
  // 没有定时器：每次新起查询时顺手清掉一小时前结束的
  const prune = () => {
    for (const [id, j] of jobs) if (j.status !== 'running' && Date.now() - j.at > 3600_000) jobs.delete(id)
  }

  async function run(job: Job) {
    const known = await mergedModelCatalog()
    const error = await runCatalogAgent(
      job,
      discoverPrompt(known, new Date().toISOString().slice(0, 10)),
      DISCOVER_MINUTES,
    )
    if (error) return fail(job, error)
    const ex = extractJson(job.text)
    if (!ex.json) return fail(job, ex.error || t('回复里没有 JSON'))
    try {
      // 查的过程中用户可能加过模型：按查完时的目录再筛一遍
      const { candidates, known: already } = newModelCandidates(parseDiscovered(ex.json), await mergedModelCatalog())
      job.candidates = candidates
      job.known = already
      job.text = ex.rest
      job.status = 'done'
      job.at = Date.now()
      log.info('models', `联网检查新模型：${candidates.length} 个新模型，${already} 个已在目录里`, {
        candidates: candidates.map((c) => `${c.vendor}/${c.id}`),
      })
    } catch (e) {
      fail(job, t('模型信息格式不对：{error}', { error: (e as Error).message }))
    }
  }

  const merged = async () => ({ entries: await mergedModelCatalog() })

  return new Hono()
    .post('/discover', (c) => {
      prune()
      // 同一时间只跑一次：连点两下不起两个 Agent
      const running = [...jobs.values()].find((j) => j.status === 'running')
      if (running) return c.json(view(running))
      const job: Job = {
        id: randomUUID(),
        status: 'running',
        text: '',
        candidates: [],
        known: 0,
        startedAt: Date.now(),
        abort: new AbortController(),
        at: Date.now(),
        cli: '',
      }
      jobs.set(job.id, job)
      void run(job).catch((e) => fail(job, (e as Error).message))
      return c.json(view(job), 201)
    })
    .get('/discover/:id', (c) => {
      const j = jobs.get(c.req.param('id'))
      return j ? c.json(view(j)) : c.json({ error: t('找不到这次查询，可能已过期') }, 404)
    })
    .post('/discover/:id/stop', (c) => {
      const j = jobs.get(c.req.param('id'))
      if (!j) return c.json({ error: t('找不到这次查询') }, 404)
      j.abort.abort()
      return c.json(view(j))
    })
    .post('/entries', async (c) => {
      const p = M.addEntries.body.safeParse(await c.req.json().catch(() => ({})))
      if (!p.success) return c.json({ error: z.prettifyError(p.error) }, 400)
      await saveModelEntries(p.data.entries)
      log.info('models', `加入 ${p.data.entries.length} 个模型到补充目录`, {
        models: p.data.entries.map((e) => `${e.vendor}/${e.id}`),
      })
      return c.json(await merged())
    })
    .post('/entries/remove', async (c) => {
      const p = M.removeEntry.body.safeParse(await c.req.json().catch(() => ({})))
      if (!p.success) return c.json({ error: z.prettifyError(p.error) }, 400)
      await removeModelEntry(p.data.vendor, p.data.id)
      return c.json(await merged())
    })
}
