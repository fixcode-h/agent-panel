/**
 * 测试进程的环境变量：去掉会改变 CLI、接口、面板和 git 行为的继承变量（单测、端到端、界面检查三个入口共用）。
 *
 * 开发机、云端容器常常带着 ANTHROPIC_BASE_URL、OPENAI_API_KEY 这类变量：服务和假 CLI 继承之后，
 * 「不走环境变量」「默认接口」这类断言会因为机器不同而失败（2026-10-28 云端容器里 accounts 分片
 * 就是被 ANTHROPIC_BASE_URL 弄红的）。面板自己的 AGENT_PANEL_DATA / AGENT_PANEL_TRAY 会把测试服务指到
 * 真实数据目录、托盘协议；git 钩子里跑测试时带着 GIT_DIR / GIT_INDEX_FILE，云端容器带着 GIT_CONFIG_*，
 * 测试里新建的临时仓库会被它们改掉行为。测试要的变量由调用方显式传，不靠继承。
 *
 * 测试入口自己的开关（AGENT_PANEL_UNIT_* / E2E_* / UI_*，比如 AGENT_PANEL_E2E_WATCHDOG_MS）是给分片读的，保留。
 */
export const INHERITED_NOISE = [
  /^ANTHROPIC_/,
  /^OPENAI_/,
  /^CLAUDE_CODE_/,
  /^CODEX_/,
  /^OPENROUTER_/,
  /^AGENT_PANEL_(?!(UNIT|E2E|UI)_)/,
  /^GIT_CONFIG_/,
  /^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|PREFIX)$/,
]

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

/** 同一类变量多于这么多个时只写「前缀*（n 个）」：云端容器里 CLAUDE_CODE_* 一带就是几十个 */
const LIST_MAX = 3

/** 日志里的一行：去掉了哪些变量（只列名字，同一类多了按前缀合并）；没去掉时返回空串 */
export function cleanedLine(tag, removed) {
  if (!removed.length) return ''
  const groups = new Map()
  for (const name of [...removed].sort()) {
    const family = /^(AGENT_PANEL_|CLAUDE_CODE_|GIT_CONFIG_|[A-Z]+_)/.exec(name)?.[1] ?? name
    groups.set(family, [...(groups.get(family) ?? []), name])
  }
  const parts = [...groups].map(([family, names]) =>
    names.length > LIST_MAX ? `${family}*（${names.length} 个）` : names.join('、'),
  )
  return `${tag} 去掉了继承的环境变量：${parts.join('、')}`
}
