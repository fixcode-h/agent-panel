/**
 * 对话标题：新建时先用第一条消息截一段，AI 第一次回复后用本机 CLI 按对话内容起一个短标题换上。
 * 每个对话只起一次（Task.autoTitle），起不出来就保留原来的标题，不打扰用户。
 */
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { getCli } from '../shared/clis.ts'
import type { Task } from '../shared/schema.ts'
import { agentRun, cliSettings, defaultCli } from '../shared/settings.ts'
import { safeArgs } from './assist.ts'
import { invokeCli } from './exec/invoke.ts'
import { childEnv } from './exec/process.ts'
import { log } from './log.ts'
import { getSettings } from './settings.ts'

const TIMEOUT = 2 * 60_000
/** 起标题的提示词开头：测试用的假 CLI 认它 */
export const TITLE_PROMPT_HEAD = '给下面这段对话起一个标题。'

/** 起标题用的对话内容：第一条用户消息和 AI 的第一次回复，各截一段就够了 */
export function titleInput(task: Pick<Task, 'messages'>) {
  const user = task.messages.find((m) => m.role === 'user' && !m.step && m.text.trim())
  const reply = task.messages.find((m) => m.role === 'agent' && m.text.trim())
  if (!user || !reply) return null
  return { user: user.text.trim().slice(0, 1500), reply: reply.text.trim().slice(0, 1500) }
}

export function titlePrompt(o: { user: string; reply: string }) {
  return [
    TITLE_PROMPT_HEAD,
    '要求：概括用户要做的事，越具体越好；中文不超过 16 个字，英文不超过 8 个词；用和用户消息相同的语言；',
    '只输出标题本身这一行，不要引号、书名号、结尾标点，不要解释，不要调用任何工具。',
    '',
    '## 用户',
    o.user,
    '',
    '## AI 的回复',
    o.reply,
  ].join('\n')
}

/** 从 CLI 的回复里取标题：第一行非空文字，去掉 Markdown 标记、引号和结尾标点 */
export function cleanTitle(text: string) {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  const s = line
    .replace(/^#+\s*/, '')
    .replace(/^(?:标题|title)\s*[:：]\s*/i, '')
    .replace(/\*\*/g, '')
    .replace(/^["'“”‘’「『《`]+|["'“”‘’」』》`]+$/g, '')
    .replace(/[。.!！?？,，;；:：]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > 40 ? s.slice(0, 40) + '…' : s
}

/** 用对话自己的 CLI（不可用时用默认 CLI）的低档模型起标题；失败返回空 */
export async function suggestTitle(task: Task, cli: string): Promise<string> {
  const input = titleInput(task)
  if (!input) return ''
  const settings = await getSettings()
  const cliId = getCli(cli) && cliSettings(settings, cli).enabled ? cli : defaultCli(settings)
  const def = getCli(cliId)
  if (!def) return ''
  const cs = cliSettings(settings, cliId)
  const run = agentRun({ cli: cliId, model: '@low' }, settings)
  // 在临时目录里跑、只读权限：只要一行文字，不该碰任何文件
  const cwd = path.join(tmpdir(), 'agent-panel-assist')
  await mkdir(cwd, { recursive: true })
  let text = ''
  let ok: boolean | undefined
  const r = await invokeCli({
    cliId,
    command: cs.command,
    build: {
      model: run.model,
      effort: run.effort,
      permission: def.readOnly || cs.permission,
      extraArgs: safeArgs(cs.extraArgs),
    },
    cwd,
    env: childEnv(cs.env),
    input: titlePrompt(input),
    timeoutMs: TIMEOUT,
    noAskTool: true,
    onEvent: (ev) => {
      if (ev.type === 'text_delta') text += ev.text
      else if (ev.type === 'text') text = ev.text
      else if (ev.type === 'result') ok = ev.ok
    },
  })
  if (r.killed || r.spawnError || !(ok ?? r.code === 0)) {
    log.warn('task', '自动起标题失败', { task: task.id, cli: cliId, code: r.code, error: r.spawnError || r.killed })
    return ''
  }
  return cleanTitle(text)
}
