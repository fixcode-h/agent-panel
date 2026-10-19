/**
 * 「AI 处理」：把页面上的报错整理成发给 AI 的第一句话（带上这一块的环境、目录等情况），
 * 页面拿去在聊天里新建一个对话，用设置里「AI 创建」的 CLI 排查和解决。对话留在聊天列表里，以后能接着看、接着问。
 * 某一块（topic）可以登记更多情况，例如本机生图（server/comfy.ts）
 */
import { Hono } from 'hono'
import { arch, homedir, platform, release } from 'node:os'
import { z } from 'zod'
import { getCli } from '../shared/clis.ts'
import { FixInput, fixPrompt, type FixStart } from '../shared/fix.ts'
import type { Settings } from '../shared/schema.ts'
import { defaultCli } from '../shared/settings.ts'
import { t } from '../shared/i18n.ts'
import { detectClis } from './detect.ts'
import { log } from './log.ts'
import { getSettings } from './settings.ts'

/** 用哪个 CLI 处理：「AI 创建」里设置的，没设置或不可用时用默认 CLI */
export const fixCli = (settings: Settings) =>
  settings.assist.cli && getCli(settings.assist.cli) ? settings.assist.cli : defaultCli(settings)

/** 某一块报错的补充：更多情况、相关的目录 */
export interface FixTopic {
  context?: () => Promise<string> | string
  cwd?: () => string
}
const topics = new Map<string, FixTopic>()
export const registerFixTopic = (id: string, topic: FixTopic) => void topics.set(id, topic)

/** cli:<id> 的报错（安装、更新、卸载、登录）：带上这个 CLI 的安装情况 */
async function cliContext(id: string) {
  const def = getCli(id)
  if (!def) return ''
  const st = (await detectClis().catch(() => [])).find((c) => c.id === id)
  return [
    `相关的 CLI：${def.name}（npm 包 ${def.npmPackage || '无'}，官方安装命令 ${def.installHint}）`,
    st
      ? `检测结果：${st.installed ? `已安装 ${st.version ?? ''}` : '没有安装'}；命令 ${st.command}${st.path ? `，实际文件 ${st.path}` : ''}${st.source ? `，安装方式 ${st.source}` : ''}${st.error ? `；检测出错 ${st.error}` : ''}`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export async function fixStart(input: FixInput): Promise<FixStart> {
  const settings = await getSettings()
  const cli = fixCli(settings)
  if (!getCli(cli)) throw new Error(t('没有可用的 CLI，请先在设置里安装并启用'))
  const topic = topics.get(input.topic)
  const extra = input.topic.startsWith('cli:')
    ? await cliContext(input.topic.slice(4))
    : ((await topic?.context?.()) ?? '')
  const dir = input.cwd || topic?.cwd?.() || homedir()
  log.info('fix', `AI 处理：${input.title}`, { topic: input.topic })
  return {
    title: input.title,
    cli,
    model: settings.assist.model,
    prompt: fixPrompt(input, { os: `${platform()} ${release()} ${arch()}`, cwd: dir, extra }),
  }
}

export function fixApi() {
  return new Hono().post('/', async (c) => {
    const p = FixInput.safeParse(await c.req.json().catch(() => ({})))
    if (!p.success) return c.json({ error: z.prettifyError(p.error) }, 400)
    try {
      return c.json(await fixStart(p.data))
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })
}
