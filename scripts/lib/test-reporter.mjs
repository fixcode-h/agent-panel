/**
 * node --test 的自定义 reporter：每个用例结束时输出一行带前缀的 JSON（文件、名字、层级、耗时、失败原因），
 * 给 scripts/unit-tests.mjs 汇总用。完整的 TAP 另由内置 tap reporter 写进日志文件。
 *
 * 为什么不直接解析 TAP：成功的用例在 TAP 里不带文件位置，按文件统计耗时、按文件重跑失败都做不了；
 * 而 TAP 本身一次全量有五十万字节，Agent 读一遍就是十几万 token。
 */
import { inspect } from 'node:util'

/** 行前缀：和用例自己往 stdout 打的东西区分开 */
export const EVENT_PREFIX = '@@unit '

/** 失败原因：断言错误的说明（含差异），加上落在测试文件里的那一帧；太长截断 */
function errorText(error, file) {
  if (!error) return ''
  const e = error.cause ?? error
  const head = typeof e?.message === 'string' && e.message ? e.message : inspect(e, { depth: 3 })
  const frame = String(e?.stack ?? '')
    .split('\n')
    .find((l) => file && l.includes(file))
  return `${head}${frame ? `\n${frame.trim()}` : ''}`.slice(0, 2000)
}

export default async function* reporter(source) {
  for await (const ev of source) {
    if (ev.type !== 'test:pass' && ev.type !== 'test:fail') continue
    const d = ev.data
    yield `${EVENT_PREFIX}${JSON.stringify({
      ok: ev.type === 'test:pass',
      name: d.name,
      file: d.file ?? '',
      nesting: d.nesting ?? 0,
      ms: d.details?.duration_ms ?? 0,
      skip: !!d.skip,
      // suite 是 describe：不算一条用例；subtestsFailed 是「里面有子用例失败」，详情在子用例那条
      suite: d.details?.type === 'suite',
      ...(ev.type === 'test:fail' && {
        error: errorText(d.details?.error, d.file),
        wrapper: d.details?.error?.failureType === 'subtestsFailed',
      }),
    })}\n`
  }
}
