/**
 * 设置页「测试连接」用哪个模型：有可选模型时用用户选中的，没选或选过的不在了就用第一个（默认模型）；
 * 一个模型都没有时返回空串，表示退回「只验证连接能列出模型」的老行为
 */
export function probeTarget(models: string[], picked: string): string {
  if (!models.length) return ''
  return models.includes(picked) ? picked : models[0]
}
