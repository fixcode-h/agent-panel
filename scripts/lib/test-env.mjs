/**
 * 测试进程的环境变量：去掉会改变 CLI 和接口行为的继承变量。
 *
 * 开发机、云端容器常常带着 ANTHROPIC_BASE_URL、OPENAI_API_KEY 这类变量：服务和假 CLI 继承之后，
 * 「不走环境变量」「默认接口」这类断言会因为机器不同而失败（2026-10-28 云端容器里 accounts 分片
 * 就是被 ANTHROPIC_BASE_URL 弄红的）。测试要的变量由调用方显式传，不靠继承。
 */
export const INHERITED_NOISE = [/^ANTHROPIC_/, /^OPENAI_/, /^CLAUDE_CODE_/, /^CODEX_/, /^OPENROUTER_/]

/** 去掉继承来的干扰变量，返回新的环境和去掉了哪些（只给名字，不给值） */
export function cleanTestEnv(env = process.env) {
  const out = {}
  const removed = []
  for (const [k, v] of Object.entries(env)) {
    if (INHERITED_NOISE.some((re) => re.test(k))) removed.push(k)
    else out[k] = v
  }
  return { env: out, removed }
}
