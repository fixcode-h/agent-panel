/**
 * 面板工具 remember（Chat 模式的跨对话记忆，server/chat-memory.ts）：Chat 页的对话记下用户的长期偏好和事实，
 * 之后每个 Chat 对话的提示词都带上（shared/chat-prompt.ts 的 memoryPart）。项目里的对话没有这个工具
 */
import type { Orchestra } from '../shared/engine.ts'
import { MEMORY_TEXT_MAX } from './chat-memory.ts'
import type { PanelTool } from './panel-tools/types.ts'

const MEMORY_TOOL = {
  name: 'remember',
  title: '记住一件事',
  description: `记下用户以后也该记住的偏好或长期事实（称呼、语言和格式偏好、常用技术栈、在做的长期项目），之后每个 Chat 对话都会带上。一条一句话，最多 ${MEMORY_TEXT_MAX} 字；不记这一次对话的细节，不记密码和密钥。记错了、用户改口了，传 forget: true 和原来那条的原文删掉它。`,
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要记的一句话；forget 为 true 时是要删掉的那条的原文' },
      forget: { type: 'boolean', description: 'true：删掉 text 这一条' },
    },
    required: ['text'],
  },
}

async function callMemory(o: Orchestra, a: Record<string, unknown> | undefined) {
  const r = o.remember
    ? await o.remember(String(a?.text ?? ''), a?.forget === true)
    : { ok: false, info: '这里没有跨对话记忆：只有 Chat 页的对话能用 remember。' }
  return { content: [{ type: 'text', text: r.info }], ...(!r.ok && { isError: true }) }
}

export const MEMORY: PanelTool = {
  name: 'remember',
  when: (o) => !!o.remember,
  def: () => MEMORY_TOOL,
  call: callMemory,
}
