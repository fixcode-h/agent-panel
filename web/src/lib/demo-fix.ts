import { FixInput, fixPrompt, type FixStart } from '@shared/fix'

/** 在线演示的「AI 处理」：和真的一样整理成第一句话，交给演示里的聊天去回复 */
export function demoFixStart(body: unknown): FixStart {
  const input = FixInput.parse(body)
  return {
    title: input.title,
    cli: 'claude',
    model: '',
    prompt: fixPrompt(input, { os: '在线演示', cwd: input.cwd || '~' }),
  }
}
