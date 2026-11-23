import { Loader2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { t } from '@shared/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/**
 * 切换内容时盖在区域上面的遮罩（用户 2026-11-20：AssetForge 左栏切配置时中间布局一闪一闪，「加个遮罩，完全显示才去掉」）。
 * 区域的框架和尺寸照常摆着，只把还没画完的内容盖住：
 * - show 一变真就马上盖上，不等动画；半透明，底下接着显示上一份内容（调用方给），看得出在换、又不空一下；
 *   转圈晚 300 毫秒才出现，快的切换不闪转圈。
 * - show 变假后再等两帧（让设计器量完尺寸、适应屏幕）才淡出，淡出完卸掉，不挡点击。
 */
export function LoadingMask({ show, label, children }: { show: boolean; label?: ReactNode; children: ReactNode }) {
  // 'on' 盖着、'fade' 淡出中、'off' 不画
  const [phase, setPhase] = useState<'on' | 'fade' | 'off'>(show ? 'on' : 'off')
  if (show && phase !== 'on') setPhase('on')
  useEffect(() => {
    if (show || phase !== 'on') return
    let id = requestAnimationFrame(() => {
      id = requestAnimationFrame(() => setPhase('fade'))
    })
    return () => cancelAnimationFrame(id)
  }, [show, phase])
  // 转圈晚一点出现：快的切换不闪一下转圈
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (phase !== 'on') {
      setSlow(false)
      return
    }
    const id = setTimeout(() => setSlow(true), 300)
    return () => clearTimeout(id)
  }, [phase])
  useEffect(() => {
    if (phase !== 'fade') return
    const id = setTimeout(() => setPhase('off'), 160)
    return () => clearTimeout(id)
  }, [phase])

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {children}
      {phase !== 'off' && (
        <div
          aria-busy={phase === 'on'}
          className={cn(
            'absolute inset-0 z-20 flex items-center justify-center bg-card/60 backdrop-blur-[1px] transition-opacity duration-150',
            phase === 'fade' && 'pointer-events-none opacity-0',
          )}
        >
          {slow && (
            <span className="flex animate-fade items-center gap-2 text-footnote text-subtle">
              <Loader2 className="h-4 w-4 animate-spin" />
              {label ?? t('读取中…')}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/** 设置 →「组件」里的示例：点按钮切换盖上 / 揭开 */
export function LoadingMaskSpecimen() {
  const [show, setShow] = useState(true)
  return (
    <div className="flex w-full flex-col gap-2">
      <div>
        <Button size="sm" onClick={() => setShow((v) => !v)}>
          {show ? t('揭开') : t('盖上')}
        </Button>
      </div>
      <div className="flex h-40 overflow-hidden rounded-lg border border-line">
        <LoadingMask show={show}>
          <div className="flex flex-1 items-center justify-center text-body text-fg">{t('内容画完后才揭开遮罩')}</div>
        </LoadingMask>
      </div>
    </div>
  )
}
