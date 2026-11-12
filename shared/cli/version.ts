import type { CliDefinition } from '../clis.ts'
import { t } from '../i18n.ts'
import { versionAtLeast } from '../hooks.ts'

/**
 * 本机版本不够用的功能（ADR 0050）：定义里带 minVersion 的（现在是钩子）收在一起，按门槛从高到低。
 * 老版本时面板悄悄不装这些（invoke.ts 按 minVersion 判断），用户只会觉得「不灵」，设置页要写出来。
 * 读不出本机版本时不提示（和 versionAtLeast 一样当成够）
 */
export function versionShortfalls(def: Pick<CliDefinition, 'hooks'>, version: string | undefined) {
  const need: { what: string; min: string }[] = []
  const h = def.hooks
  const mins = [h?.beforeEnd?.minVersion, ...Object.values(h?.events ?? {}).map((e) => e?.minVersion)]
  const hook = mins.filter((m): m is string => !!m && !versionAtLeast(version, m))
  // 钩子的几个事件门槛一样时只说一次，取最高的那个
  if (hook.length) need.push({ what: t('钩子'), min: hook.reduce((a, b) => (versionAtLeast(a, b) ? a : b)) })
  return need
}
