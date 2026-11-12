import { HookDef, type HookDefInput } from './hooks/defs.ts'
import { CLIS } from './clis.ts'
import { supportedEvents } from './hooks.ts'
import { promptLangWord } from './prompt-lang.ts'
import type { AssistMessage } from './assist.ts'
import type { Agent } from './schema.ts'

/**
 * 设置页「钩子」的 AI 创建（ADR 0049 第二期，设计稿第 7 节）：提示词把钩子规范、各事件的输入输出、
 * 各 CLI 支持哪些事件、几个范例都交给 CLI；CLI 交回一个 JSON 提案，这里按 HookDef 校验。
 * 语法、密钥、试跑由服务端在保存前再查一遍（server/hooks/validate.ts），这里只管形状。
 * 从 shared/assist.ts 拆出来：那个文件到了行数上限。发给 Agent 的提示词，不翻译
 */

/** AI 交的钩子提案：保存时一律关着（enabled=false），用户看过再打开 */
export type HookProposal = { kind: 'hook'; hook: HookDefInput }

const EXAMPLE_GUARD = `// 例：只读的项目里不许改 migrations/ 下的文件
let raw = ''
process.stdin.on('data', (c) => (raw += c)).on('end', () => {
  const input = JSON.parse(raw)
  const file = String(input.tool?.input?.file_path ?? '')
  if (input.tool?.kind === 'edit' && file.includes('/migrations/'))
    process.stdout.write(JSON.stringify({ deny: true, reason: '迁移文件只能由 DBA 改：把要改的写进结果交回' }))
})`

const EXAMPLE_LINT = `// 例：改完 TypeScript 文件后提醒跑类型检查
let raw = ''
process.stdin.on('data', (c) => (raw += c)).on('end', () => {
  const input = JSON.parse(raw)
  if (input.tool?.kind === 'edit' && /\\.tsx?$/.test(String(input.tool?.input?.file_path ?? '')))
    process.stdout.write(JSON.stringify({ context: '改了 TypeScript 文件：这一步做完前跑一次 npm run typecheck' }))
})`

/** 设置页带来的项目清单（id、名称）：AI 按名称写范围，面板换成 id */
const projectsOf = (subject: Record<string, string>): { id: string; name: string }[] => {
  try {
    const v = JSON.parse(subject.projects || '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is { id: string; name: string } => !!x && typeof x.id === 'string') : []
  } catch {
    return []
  }
}

export function buildHookPrompt(subject: Record<string, string>, messages: AssistMessage[], agents: Agent[]) {
  const convo = messages
    .map((m) => `### ${m.role === 'user' ? '用户' : '你（上一轮的回复）'}\n${m.text.trim()}`)
    .join('\n\n')
  const support = CLIS.map((c) => `- ${c.name}（${c.id}）：${supportedEvents(c.hooks).join('、') || '都不支持'}`).join(
    '\n',
  )
  const cur = subject.hook?.trim()
  const roles = agents.map((a) => a.name).join('、') || '（没有）'
  const projects =
    projectsOf(subject)
      .map((p) => p.name)
      .join('、') || '（没有）'
  return [
    `你是「Agent 面板」里的配置助手，正在帮用户${cur ? '**改写一个钩子**' : '**新建一个钩子**'}。钩子在 Agent 执行的固定时刻自动运行：模型准备结束这一轮、调用工具前后、压缩上下文之后。`,
    cur ? `## 现在的钩子\n\`\`\`json\n${cur}\n\`\`\`` : '',
    `## 事件
- turn.beforeEnd：模型准备结束这一轮。输出 {"block": true, "reason": "…"} 拦住，让它在同一轮里按 reason 接着做；不表态就输出空。
- tool.before：工具执行前。输出 {"deny": true, "reason": "…"} 拒绝这次调用（reason 会交给模型），或 {"context": "…"} 补一段说明。
- tool.after：工具返回后。输出 {"context": "…"} 补一段说明。
- context.restored：压缩上下文、续接之后。输出 {"context": "…"} 补一段说明。
- 下面几个由面板自己发、只通知（输出不看，每个 CLI 都一样）：task.done 对话完成一轮、task.failed 对话失败、task.waitingUser 停下来等用户回复或确认、
  task.wrapRequested 子对话请求收尾、plan.stepDone 计划的某一步做完、schedule.finished 计划任务跑完（成功启动 / 启动失败 / 错过 / 上游没成功）。
  适合做通知：用 HTTP 动作发到飞书、Slack 这类地址，或者脚本里调系统通知。

各 CLI 能装的事件（只通知的那几个不用 CLI 支持）：
${support}`,
    `## 钩子收到的输入（stdin 一段 JSON）
{ "event": "tool.before", "task": { "id", "title", "parent" }, "project": { "id", "path" }, "agent": { "id", "name" }, "cli": "claude",
  "tool": { "kind": "shell | edit | read | panel | any", "name": "Edit", "input": { 原样的工具参数，例如 file_path、command },
            "panel": "面板工具去掉前缀的名字（kind 是 panel 时）", "result": { "output": "执行结果（截短）", "failed": true } },
  "plan": { "done": 1, "total": 3, "current": "正在做的那一步" } }
tool 只在 tool.* 里有，result 只在 tool.after 里有（failed 只有 Claude Code、Pi、Command Code 报得出，其余没有这个字段）；plan 在有计划时才有。只通知的事件里有 "notice": { "status": "对话状态", "step": "做完的那一步或收尾说明" }；
schedule.finished 里有 "schedule": { "result": "run | fail | miss | blocked", "scheduleId", "name", "projectName", "at", "taskId", "error" }。**输入里没有模型回复的文字**：不要、也没法按回复内容的关键字判断状态。`,
    `## 字段
- name：2–10 个字；description：一句话说明它做什么。
- event：上面的事件之一。
- scope：{ "projects": [], "agents": [], "clis": [] }，都空表示全部。projects 写项目名，agents 写角色名（面板换成内部 id），clis 写 CLI 的 id。
  可选的角色：${roles}
  可选的项目：${projects}
- match（只给 tool.*）：{ "tool": "shell | edit | read | panel | any", "path": "相对项目根的 glob，可空", "command": "shell 命令前缀（会按 &&、; 拆开逐段比）；tool 是 panel 时填面板工具名，例如 submit_merge，可空" }；其余事件写 { "tool": "any", "path": "", "command": "" }。
- action：二选一
  - { "type": "command", "script": "Node.js 脚本（ESM），从 stdin 读输入，往 stdout 写一个 JSON 或什么都不写" }
  - { "type": "http", "url": "https://…", "headers": [{ "key": "Authorization", "env": "环境变量名" }] }
- timeoutSec：1–60，默认 5；onError：allow（出错放行，默认）或 deny（只对 tool.before，出错就拒绝）。`,
    `## 规则
- 判断只看输入里的结构化字段（工具类别、文件路径、命令、计划进度），不要按任何文字关键字猜模型做没做完。
- 脚本里不写密钥、令牌、密码：要用凭据就从 process.env 读，并在说明里告诉用户要设哪个环境变量。
- 脚本出错、拿不准时就什么都不输出（放行）；拦住、拒绝时 reason 写清楚为什么、该怎么做，它会原样交给模型。
- 脚本只用 Node 自带的模块，不 import 第三方包；不要写会改用户文件、联网上传数据的逻辑，除非用户明确要求。
- 钩子保存后默认是关着的，用户看过再打开，所以不用写 enabled。`,
    `## 范例
\`\`\`js
${EXAMPLE_GUARD}
\`\`\`
\`\`\`js
${EXAMPLE_LINT}
\`\`\``,
    `## 输出格式
先用两三句${promptLangWord()}说明这个钩子什么时候触发、会做什么，需要用户设的环境变量也写出来。
然后输出且只输出一个 \`\`\`json 代码块，内容是钩子的定义（上面「字段」里的那些，不写 id、enabled）。`,
    `## 对话\n${convo}`,
    '请回复用户最后一条消息。',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** 校验 CLI 交的 JSON：形状不对返回给 CLI 看的错误；一律存成关着的、来源 ai */
export function resolveHookProposal(
  json: unknown,
  subject: Record<string, string>,
  agents: Agent[],
): { proposal?: HookProposal; error?: string } {
  const id = (() => {
    try {
      return String((JSON.parse(subject.hook || '{}') as { id?: unknown }).id ?? '')
    } catch {
      return ''
    }
  })()
  const p = HookDef.safeParse({
    ...(json && typeof json === 'object' ? json : {}),
    id: id || 'new',
    enabled: false,
    createdBy: 'ai',
  })
  if (!p.success) return { error: p.error.issues.map((i) => `${i.path.join('.')}：${i.message}`).join('；') }
  // 范围里写的是名字：换成 id；对不上的退回给 CLI 改（不然保存后这个钩子永远不会触发）
  const projects = projectsOf(subject)
  const byName = <T extends { id: string; name: string }>(list: T[], names: string[]) =>
    names.map((n) => list.find((x) => x.id === n || x.name === n)?.id ?? `?${n}`)
  const scope = {
    ...p.data.scope,
    agents: byName(agents, p.data.scope.agents),
    projects: byName(projects, p.data.scope.projects),
  }
  const bad = [...scope.agents, ...scope.projects].filter((x) => x.startsWith('?')).map((x) => x.slice(1))
  if (bad.length)
    return {
      error: `scope 里这些名字对不上已有的角色或项目：${bad.join('、')}。只能写上面列出的名字，或者留空表示全部。`,
    }
  const { updatedAt: _u, ...hook } = p.data
  return { proposal: { kind: 'hook', hook: { ...hook, id, scope } } }
}
