/**
 * 把旧格式的原始任务 JSON 上平铺的一组字段就地收进一个子对象（task.budget、task.analysis…），返回改没改。
 * 只给数据目录的一次性迁移（server/migrations/）和导入旧导出文件（shared/tasks/export.ts）用，读任务时不调。
 *
 * - legacy：旧的顶层键 → 子对象里的键。旧键可以和子对象同名（旧的 analysis 是字符串、新的是对象）：
 *   这个键上已经是对象时按新格式算，不当旧字段搬
 * - drop：这个值是默认值、不值得留（例如 0 表示不限）时返回 true，搬的时候直接丢掉；丢完什么都没剩就不造出子对象
 * 已经是新格式的再跑一遍不动，所以可以重复跑（迁移要幂等）
 */
export function liftFields(
  raw: Record<string, unknown>,
  key: string,
  legacy: Record<string, string>,
  drop?: (to: string, v: unknown) => boolean,
): boolean {
  const cur = raw[key]
  const curIsObj = isObj(cur)
  const found = Object.keys(legacy).filter((k) => k in raw && !(k === key && curIsObj))
  if (!found.length) return false
  const sub: Record<string, unknown> = curIsObj ? { ...cur } : {}
  for (const k of found) {
    const v = raw[k]
    delete raw[k] // delete-ok: 原始 JSON 对象，不是经 store.update 合并的 Task
    const to = legacy[k]!
    if (v === undefined || v === null || drop?.(to, v)) continue
    if (!(to in sub)) sub[to] = v
  }
  if (Object.keys(sub).length) raw[key] = sub
  else delete raw[key] // delete-ok: 同上
  return true
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
