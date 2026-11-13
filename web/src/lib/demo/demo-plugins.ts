import { fail } from '../demo-http'

/** 演示后端的插件接口（web/src/lib/demo-backend.ts 转过来） */
export function demoPlugins(method: string, id?: string) {
  // 在线演示不装插件：插件页显示空列表；插件市场给一份示例目录（不连 GitHub），点安装报「演示里不能装」
  if (!id && method === 'GET') return { plugins: [], broken: [], market: 'fixcode-h/agent-plugins' }
  if (id === 'market' && method === 'GET')
    return {
      repo: 'fixcode-h/agent-plugins',
      defaultRepo: 'fixcode-h/agent-plugins',
      fetchedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      plugins: [
        {
          id: 'ue',
          name: 'UE',
          version: '0.9.1',
          icon: 'gamepad',
          description: '按项目连接正在运行的 Unreal Engine：控制台、GM、找 Actor、读改运行时属性、DataTable 和资源。',
        },
        {
          id: 'blender',
          name: 'Blender',
          version: '3.1.0',
          icon: 'box',
          description: '让 Agent 直接驱动你的 Blender：GUI 会话里执行 Python、看视口、跑建模算子。',
        },
        {
          id: 'tables',
          name: '表格',
          version: '1.2.0',
          icon: 'table',
          description: '游戏配置表浏览、搜索、在线改单元格，表头结构可配置，跨表搜索替换。',
        },
        {
          id: 'video',
          name: '视频截帧',
          version: '1.0.0',
          icon: 'film',
          description: '把视频拖进对话输入框就能截帧：手动截、按画面变化自动截，选段、标注、去重。',
        },
      ],
    }
  if (id === 'updates' && method === 'GET') return { updates: [], errors: [], checkedAt: new Date().toISOString() }
  return fail('在线演示不能安装插件，要在本机运行面板')
}
