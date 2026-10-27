import type { ApiConfig, ApiProtocol } from './accounts.ts'
import { t } from './i18n.ts'

/**
 * 常见的大模型厂家：API 配置的名称可以从这里选，选了接口地址就跟着厂家的协议走
 * （厂家地址只作为输入框的提示，用户自己填了就用自己的）。urls 按协议给地址，第一个是厂家默认的协议；
 * 只列厂家官方文档里写明的兼容接口。
 */
export interface ApiVendor {
  name: string
  /** 写进 CLI 配置的 provider 名 */
  provider: string
  urls: Partial<Record<ApiProtocol, string>>
  /**
   * 能查账户余额的厂家才有：余额接口（GET，Authorization: Bearer 密钥）。
   * 没有这个字段表示这个厂家没有公开的余额接口，界面上说明它不支持余额查询
   */
  balance?: { url: string }
}

export const API_VENDORS: ApiVendor[] = [
  { name: 'Anthropic', provider: 'anthropic', urls: { anthropic: 'https://api.anthropic.com' } },
  {
    name: 'OpenAI',
    provider: 'openai',
    urls: { 'openai-responses': 'https://api.openai.com/v1', 'openai-chat': 'https://api.openai.com/v1' },
  },
  {
    name: 'DeepSeek',
    provider: 'deepseek',
    urls: { 'openai-chat': 'https://api.deepseek.com/v1', anthropic: 'https://api.deepseek.com/anthropic' },
    balance: { url: 'https://api.deepseek.com/user/balance' },
  },
  {
    name: t('Kimi（月之暗面）'),
    provider: 'moonshot',
    urls: { 'openai-chat': 'https://api.moonshot.cn/v1', anthropic: 'https://api.moonshot.cn/anthropic' },
  },
  {
    name: t('智谱 GLM'),
    provider: 'zhipu',
    urls: {
      'openai-chat': 'https://open.bigmodel.cn/api/paas/v4',
      anthropic: 'https://open.bigmodel.cn/api/anthropic',
    },
  },
  {
    name: t('通义千问（阿里云百炼）'),
    provider: 'dashscope',
    urls: {
      'openai-chat': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      anthropic: 'https://dashscope.aliyuncs.com/apps/anthropic',
    },
  },
  {
    name: 'MiniMax',
    provider: 'minimax',
    urls: { 'openai-chat': 'https://api.minimaxi.com/v1', anthropic: 'https://api.minimaxi.com/anthropic' },
  },
  {
    // 品牌名不翻译；Anthropic 协议的地址不带 /v1（官方网关就是根地址）
    name: 'OpenDesign',
    provider: 'opendesign',
    urls: { 'openai-chat': 'https://amr-link.open-design.ai/v1', anthropic: 'https://amr-link.open-design.ai' },
  },
  {
    name: t('豆包（火山方舟）'),
    provider: 'volcengine',
    urls: { 'openai-chat': 'https://ark.cn-beijing.volces.com/api/v3' },
  },
  { name: t('腾讯混元'), provider: 'hunyuan', urls: { 'openai-chat': 'https://api.hunyuan.cloud.tencent.com/v1' } },
  { name: t('百度千帆'), provider: 'qianfan', urls: { 'openai-chat': 'https://qianfan.baidubce.com/v2' } },
  { name: t('硅基流动'), provider: 'siliconflow', urls: { 'openai-chat': 'https://api.siliconflow.cn/v1' } },
  { name: 'OpenRouter', provider: 'openrouter', urls: { 'openai-chat': 'https://openrouter.ai/api/v1' } },
  { name: 'xAI Grok', provider: 'xai', urls: { 'openai-chat': 'https://api.x.ai/v1' } },
  { name: 'Mistral', provider: 'mistral', urls: { 'openai-chat': 'https://api.mistral.ai/v1' } },
  { name: 'Groq', provider: 'groq', urls: { 'openai-chat': 'https://api.groq.com/openai/v1' } },
  { name: t('Ollama（本机）'), provider: 'ollama', urls: { 'openai-chat': 'http://localhost:11434/v1' } },
]

export const findVendor = (name: string) => API_VENDORS.find((v) => v.name === name.trim())

/** 选厂家后用哪个协议和地址：当前协议它支持就保留，不支持就换成厂家默认的 */
export function vendorEndpoint(v: ApiVendor, protocol: ApiProtocol): { protocol: ApiProtocol; baseUrl: string } {
  if (v.urls[protocol]) return { protocol, baseUrl: v.urls[protocol]! }
  const [p, url] = Object.entries(v.urls)[0] as [ApiProtocol, string]
  return { protocol: p, baseUrl: url }
}

/**
 * 实际要用的接口地址：用户自己填了就用用户的，留空时用厂家按协议给的默认地址。
 * 界面上厂家地址只是输入框的灰字提示，请求、探测和写进 CLI 配置都按这里算，
 * 免得出现「输入框空着、请求却打了厂家地址」这种看不出来的状态
 */
export function apiBaseUrl(api: Pick<ApiConfig, 'protocol' | 'baseUrl'> & { name?: string }): string {
  const own = api.baseUrl.trim()
  if (own) return own
  return (api.name && findVendor(api.name)?.urls[api.protocol]) ?? ''
}

/** 这个地址是不是内置厂家给的：旧版本把厂家地址写进了真实值，切换厂家或协议时据此清掉 */
export function isVendorUrl(url: string): boolean {
  const u = url.trim()
  return !!u && API_VENDORS.some((v) => Object.values(v.urls).includes(u))
}

/** 查余额的接口地址：厂家定义里没有 balance 时为空，表示这个厂家不支持余额查询 */
export const apiBalanceUrl = (api: Pick<ApiConfig, 'name'>) => findVendor(api.name)?.balance?.url ?? ''
