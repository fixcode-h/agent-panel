import { t } from './i18n.ts'

/**
 * API 账户余额：DeepSeek 有公开的余额接口（GET /user/balance），
 * 返回 { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }。
 * 解析单独放在这里（纯函数、不发请求），服务端只管带上密钥去请求：格式认不出时抛出能直接显示给用户的原因。
 */

export interface ApiBalanceRow {
  /** 币种，例如 CNY、USD */
  currency: string
  /** 总余额（可用） */
  total: string
  /** 赠送的额度里还剩多少 */
  granted: string
  /** 自己充值的额度里还剩多少 */
  toppedUp: string
}

export interface ApiBalance {
  /** 余额能不能用；false 表示额度已经用完，接口会拒绝请求 */
  available: boolean
  /** 每种币种一行 */
  rows: ApiBalanceRow[]
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')

/** 解析余额接口的返回；认不出的格式抛错（错误里只放固定文案，不把返回原文带出来） */
export function parseApiBalance(body: unknown): ApiBalance {
  const rec = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const list = Array.isArray(rec.balance_infos) ? rec.balance_infos : []
  const rows = list
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => ({
      currency: str(x.currency),
      total: str(x.total_balance),
      granted: str(x.granted_balance),
      toppedUp: str(x.topped_up_balance),
    }))
    .filter((r) => r.currency)
  if (!rows.length) throw new Error(t('接口没有返回余额信息'))
  return { available: rec.is_available !== false, rows }
}
