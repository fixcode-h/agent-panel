import { Hono } from 'hono'
import { z } from 'zod'
import { ApiConfig, apiForProtocol, apiProtocols, type ApiProtocol } from '../../shared/accounts.ts'
import { apiBaseUrl } from '../../shared/api-vendors.ts'
import { t } from '../../shared/i18n.ts'
import { probeRequest } from '../accounts.ts'
import { hasContent, largePrompt, type SpeedRow } from '../../shared/api-speed.ts'

/**
 * API 测速（设置 › API 的「测速」）：对这个 API 支持的每种协议各发一个小请求、一个大请求（流式），
 * 量首包（从发出到第一段模型输出）和总耗时。
 *
 * 为什么要大请求：同一个中转站，小请求各协议都在 1 秒左右，大请求却可能差出十倍
 *（2026-11-04 实测某中转站约 3.7 万 token 的输入：OpenAI 协议首包 1.7–2.8 秒，Anthropic 协议 13–16 秒）。
 * Agent 每一步都带着整段上下文，真实体感接近大请求。密钥只放在请求头里，错误只带固定文案和接口给的原因
 */

/** 小请求：一句话，看链路本身的往返 */
const SMALL_PROMPT = '用一句话回答：1 + 1 等于几？'
/** 每次只要很少的输出：测的是首包，不是生成速度 */
const SPEED_MAX_TOKENS = 64
/** 单个请求最多等多久：大请求在慢的链路上要十几秒，给足但有上限 */
const SPEED_TIMEOUT_MS = 90_000

async function measure(
  api: Pick<ApiConfig, 'protocol' | 'baseUrl' | 'apiKey' | 'authHeader'>,
  protocol: ApiProtocol,
  model: string,
  prompt: string,
): Promise<Omit<SpeedRow, 'protocol' | 'size'>> {
  const base = apiBaseUrl(api).replace(/\/+$/, '')
  const [url, body, headers] = probeRequest(protocol, base, model, api.apiKey.trim(), api.authHeader)
  const req =
    protocol === 'openai-responses'
      ? { ...body, input: prompt, max_output_tokens: SPEED_MAX_TOKENS, stream: true }
      : { ...body, messages: [{ role: 'user', content: prompt }], max_tokens: SPEED_MAX_TOKENS, stream: true }
  const t0 = performance.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(SPEED_TIMEOUT_MS),
    })
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      return { error: t('接口返回 {status}：{detail}', { status: String(res.status), detail: text.slice(0, 200) }) }
    }
    let first: number | undefined
    let buf = ''
    const dec = new TextDecoder()
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      if (first !== undefined) continue
      // 只留最后一小段：增量事件可能被切在两块之间
      buf = (buf + dec.decode(chunk, { stream: true })).slice(-4000)
      if (hasContent(protocol, buf)) first = performance.now() - t0
    }
    const total = performance.now() - t0
    if (first === undefined) return { totalMs: Math.round(total), error: t('接口没有返回模型输出') }
    return { firstMs: Math.round(first), totalMs: Math.round(total) }
  } catch (e) {
    const err = e as Error
    if (err.name === 'TimeoutError')
      return { error: t('{seconds} 秒内没有响应', { seconds: String(SPEED_TIMEOUT_MS / 1000) }) }
    return { error: t('连不上接口：{error}', { error: err.message }) }
  }
}

/**
 * 测一个 API：每种协议先小后大，依次发（并发会互相抢带宽、抢并发名额，数字就不准了）。
 * model 是用户在「测试连接」旁边选的那个模型；某种协议下这个模型不可用时，用这种协议的第一个模型
 */
export async function speedTestApi(api: ApiConfig, model: string): Promise<SpeedRow[]> {
  if (!api.apiKey.trim()) throw new Error(t('先填密钥'))
  const rows: SpeedRow[] = []
  const large = largePrompt()
  for (const protocol of apiProtocols(api)) {
    const p = apiForProtocol(api, protocol)
    const m = p.models.includes(model) ? model : (p.models[0] ?? model)
    if (!m) {
      rows.push({ protocol, size: 'small', error: t('先选一个模型') })
      continue
    }
    for (const [size, prompt] of [
      ['small', SMALL_PROMPT],
      ['large', large],
    ] as const)
      rows.push({ protocol, size, ...(await measure(p, protocol, m, prompt)) })
  }
  return rows
}

/** 设置页「测速」的接口：挂在 /api/accounts 下（和测试连接、查余额同一组），密钥由服务端带着去请求 */
export function apiSpeedApi() {
  return new Hono().post('/api-speed', async (c) => {
    const p = z.object({ api: ApiConfig, model: z.string().trim().default('') }).safeParse(await c.req.json())
    if (!p.success) return c.json({ error: z.prettifyError(p.error) }, 400)
    try {
      return c.json({ rows: await speedTestApi(p.data.api, p.data.model) })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })
}
