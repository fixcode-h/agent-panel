import type { ApiProtocol } from './accounts.ts'
import { t } from './i18n.ts'

/**
 * 常见的大模型厂家：API 配置的名称可以从这里选，选了就按协议填好接口地址（之后仍可自己改）。
 * urls 按协议给地址，第一个是厂家默认的协议；只列厂家官方文档里写明的兼容接口。
 */
export interface ApiVendor {
  name: string
  /** 写进 CLI 配置的 provider 名 */
  provider: string
  urls: Partial<Record<ApiProtocol, string>>
}

export const API_VENDORS: ApiVendor[] = [
  { name: 'Anthropic', provider: 'anthropic', urls: { anthropic: 'https://api.anthropic.com' } },
  {
    name: 'OpenAI',
    provider: 'openai',
    urls: { 'openai-responses': 'https://api.openai.com/v1', 'openai-chat': 'https://api.openai.com/v1' },
  },
  { name: 'Gemini', provider: 'gemini', urls: { gemini: 'https://generativelanguage.googleapis.com' } },
  {
    name: 'DeepSeek',
    provider: 'deepseek',
    urls: { 'openai-chat': 'https://api.deepseek.com/v1', anthropic: 'https://api.deepseek.com/anthropic' },
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
