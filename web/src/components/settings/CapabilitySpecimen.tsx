import { Gamepad2 } from 'lucide-react'
import { t } from '@shared/i18n'
import { StatusPill } from '@/components/ui/status-pill'
import { CapabilityGroup, CapabilityRow, EffectBadge } from '@/components/ui/capability-row'
import { CapabilityServerHeader } from '@/components/ui/capability-server-header'
import type { ToolEffect } from '@shared/mcp-catalog/types'

/** 设置 → 组件里的能力行样例（设置 →「MCP」用的同一套部件）：示例数据不翻译 */
const EFFECTS: ToolEffect[] = ['read', 'edit', 'verify', 'dispatch', 'ask', 'confirm', 'danger']

export function CapabilitySpecimen() {
  return (
    <div className="flex w-full max-w-2xl flex-col gap-4">
      <CapabilityServerHeader
        icon={Gamepad2}
        name="UE"
        meta="插件 0.9.1 · MCP 服务 ue"
        status={<StatusPill tone="ok">{t('插件已开启')}</StatusPill>}
        summary="连接正在运行的 Unreal Engine：控制台、找对象、读改属性、资源和蓝图、日志和截图。"
        rows={[{ label: t('什么时候挂'), value: '接入 UE 的项目里的 Agent 对话；Chat 和设计模式不挂。' }]}
        hint="（UE 工具）先 ue_status 看有没有在运行、目标是哪个世界……"
      />
      <span className="flex flex-wrap gap-1.5">
        {EFFECTS.map((e) => (
          <EffectBadge key={e} effect={e} />
        ))}
      </span>
      <CapabilityGroup title="运行时对象" count={3}>
        <CapabilityRow
          title="改属性"
          name="ue_set"
          summary="改运行时对象属性、数组元素、Lua 简单字段；进操作记录可撤回。"
          useWhen="调数值复现或验证修复；用户让你改某个属性时"
          avoidWhen="要永久改资源默认值时还要 ue_save"
          effects={['edit']}
          description="改属性：path + prop + value……"
          params={[
            { name: 'path', type: 'string', description: '对象路径', required: true },
            { name: 'value', type: 'string', description: 'JSON 值', required: false },
          ]}
        />
        <CapabilityRow
          title="后台命令"
          name="run_background"
          summary="把要跑很久的命令交给面板在后台跑，结果推回对话。"
          useWhen="编译、全量测试、装依赖这类超过一分钟的命令"
          effects={['dispatch']}
          audience={['parent', 'child', 'helper', 'node', 'chat']}
          description="只用于要跑很久的命令……"
        />
        <CapabilityRow
          title="执行算子"
          name="dsh_op"
          summary="在 Blender 里执行一个建模算子。"
          effects={['edit']}
          description=""
          missing
        />
      </CapabilityGroup>
    </div>
  )
}
