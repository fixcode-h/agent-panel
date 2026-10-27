/**
 * 静态数一个测试文件里有几条用例（scripts/test-budget.mjs 用）：不跑测试，秒级。
 * 只认行首的调用，注释里、字符串里提到的不算；数得不精确没关系，要的是「涨了看得见」。
 */
const PATTERNS = {
  /** 单测：test(…) / it(…) / test.skip(…)，describe 不算 */
  unit: /^\s*(?:test|it)(?:\.(?:skip|only|todo))?\(/,
  /** 端到端：每个 step('…') 是一步验收 */
  e2e: /^\s*(?:await\s+)?step\(/,
  /** 界面检查：每个 check(p, '…') 是一次截图 + 断言 */
  ui: /^\s*(?:await\s+)?check\(/,
}

export function countCases(source, kind) {
  const re = PATTERNS[kind]
  if (!re) throw new Error(`不认识的种类：${kind}`)
  return String(source)
    .split('\n')
    .filter((l) => re.test(l)).length
}
