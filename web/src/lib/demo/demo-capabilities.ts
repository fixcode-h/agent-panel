import { probeRow, type CapabilityProbe, type CapabilityProbeInput } from '@shared/projects/capability-probe'

/**
 * 演示后端的项目「能力」探查（web/src/lib/demo/demo-backend.ts 转过来）：演示不装插件，这里按市场里的
 * 表格、UE 两个按项目生效的插件给示例行，推荐理由按演示项目的目录名给，拼行用和正式后端同一个 probeRow
 */
const DEMO_PLUGINS = [
  {
    id: 'tables',
    name: '表格',
    icon: 'table',
    description: '读写、比较游戏配置表；项目工具里出现「表格」页，Agent 能用表格的 MCP 工具。',
    detect: (path: string) => (/game|client/.test(path) ? '找到 Content/Data 下 312 张 xlsx' : ''),
    ready: (plugins: Record<string, unknown>) =>
      (plugins.tables as { dir?: string } | undefined)?.dir ? '' : '还要选表格目录',
  },
  {
    id: 'ue',
    name: 'UE',
    icon: 'gamepad',
    description: '连上 UE 编辑器读写资源、蓝图，抓性能数据。',
    detect: (path: string) => (/game|client/.test(path) ? '找到 TPSProject.uproject' : ''),
    ready: () => '还没装 UELink：在 UE 页一键安装',
  },
]

export function demoCapabilities(body: unknown): CapabilityProbe {
  const input = (body ?? {}) as Partial<CapabilityProbeInput>
  const path = input.path ?? ''
  return {
    plugins: DEMO_PLUGINS.map((p) =>
      probeRow(p, { enabled: true, reason: path ? p.detect(path) : '', missing: p.ready(input.plugins ?? {}) }),
    ),
  }
}
