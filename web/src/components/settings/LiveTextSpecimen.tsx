import { Brain } from 'lucide-react'
import { t } from '@shared/i18n'
import { LiveText } from '@/components/ui/live-text'
import { DraftRow } from '@/components/tasks/RunningNow'

/** 样张数据（不翻译）：思考到一半、正在写诊断报告的入参 */
const THINKING =
  '先看日志：点击后 store 已经更新，但角标没重新渲染。\n\n怀疑 selector 返回了同一个对象引用，memo 比较认为没变。\n\n再确认一下 useCart 的写法……'
const DRAFT =
  'phase：evidence\n\nsymptom：加入购物车后右上角数字不变，刷新后才对\n\nhypotheses：\n  - \n    cause：selector 返回同一个对象引用\n    score：3\n  - \n    cause：角标组件被 memo 挡住'

/**
 * 设置 → 组件里的实时输出样张：上面是正在思考，下面是模型正在写工具入参（交诊断报告）时「正在写」那一行和写到哪了。
 * 两处用同一个 LiveText，限高、竖线、要不要显示写到哪了改了马上看得到
 */
export function LiveTextSpecimen() {
  return (
    <div className="flex w-full max-w-3xl flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="flex items-center gap-1.5 text-xs text-subtle">
          <Brain className="h-3.5 w-3.5 animate-pulse text-accent-text" />
          <span className="thinking-shimmer">{t('正在思考…')}</span>
        </span>
        <LiveText text={THINKING} live />
      </div>
      <div className="proc-list flex flex-col">
        <DraftRow tool="mcp__panel__submit_diagnosis" since={new Date().toISOString()} text={DRAFT} now={Date.now()} />
      </div>
    </div>
  )
}
