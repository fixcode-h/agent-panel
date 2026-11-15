import { FixInput, fixPrompt, type FixStart } from '@shared/fix'
import { MEMORY_TOPIC, memoryBrief } from '@shared/memory'
import { TASK_MEMORY_TOPIC, taskMemoryBrief } from '@shared/memory-analysis'

/** 在线演示的「AI 处理」：和真的一样整理成第一句话，交给演示里的聊天去回复 */
export function demoFixStart(body: unknown): FixStart {
  const input = FixInput.parse(body)
  // 真机上 topic 的补充情况由服务端给（运行环境、目录）；演示版没有服务端，自己补上
  const extra =
    input.topic === MEMORY_TOPIC
      ? `${memoryBrief()}\n\n运行环境：在线演示（浏览器里模拟的面板，没有真的 Node 进程，上面的数字是演示数据）。`
      : input.topic === TASK_MEMORY_TOPIC
        ? `${taskMemoryBrief()}\n\n运行环境：在线演示（浏览器里模拟的面板，没有真的 Node 进程，上面的数字是演示数据）。`
        : ''
  return {
    title: input.title,
    cli: 'claude',
    model: '',
    prompt: fixPrompt(input, { os: '在线演示', cwd: input.cwd || '~', extra }),
  }
}
