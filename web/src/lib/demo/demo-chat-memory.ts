/**
 * 在线演示里的「关于我与记忆」（server/chat-memory.ts 的模拟）：存在浏览器内存里，刷新就回到示例。
 * 演示里的 Chat 对话不会真的调 remember，这里先放两条示例记忆让设置页有东西看
 */
type Item = { id: string; text: string; at: string }
const mem: { about: string; items: Item[] } = {
  about: '叫我小王。回复用中文，先给结论再展开；前端用 React + TypeScript。',
  items: [
    { id: 'demo-m1', text: '用户的电脑是 Windows，命令要能在 PowerShell 里跑', at: '2026-10-28T09:00:00.000Z' },
    { id: 'demo-m2', text: '写周报时用「本周完成 / 下周计划 / 风险」三段', at: '2026-11-01T09:00:00.000Z' },
  ],
}

export function demoChatMemory(method: string, path: string[], body: Record<string, unknown>) {
  const view = () => structuredClone(mem)
  // path[0] 是 'chat-memory'，后面才是子路径
  const seg = path.slice(1)
  if (method === 'PUT' && seg[0] === 'about') mem.about = String(body.about ?? '').trim()
  else if (method === 'POST' && seg[0] === 'items') {
    const text = String(body.text ?? '').trim()
    if (text && !mem.items.some((x) => x.text === text))
      mem.items.push({ id: `demo-${crypto.randomUUID()}`, text, at: new Date().toISOString() })
  } else if (method === 'DELETE' && seg[0] === 'items') mem.items = mem.items.filter((x) => x.id !== seg[1])
  return view()
}
