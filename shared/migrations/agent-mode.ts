import { convMode } from '../conv-mode.ts'

/**
 * 迁移 0012 的转换（正式后端和演示版 localStorage 共用）：以前 Chat 页的对话和项目里的对话、子对话都存 mode = chat，
 * 要区分只能再看 projectId、parentTaskId，插件就因为只看 mode 把项目对话当成了 Chat 页的对话、不挂工具（用户 2026-11-19 定分开存）。
 * 有项目或者有父对话的 chat 改成 agent；工作流和 Chat 页的对话不动。返回改没改
 */
export function splitAgentMode(raw: Record<string, unknown>): boolean {
  if (raw.mode !== 'chat') return false
  const mode = convMode({ projectId: str(raw.projectId), parentTaskId: str(raw.parentTaskId) })
  if (mode === 'chat') return false
  raw.mode = mode
  return true
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
