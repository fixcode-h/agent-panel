import { useState } from 'react'
import { t } from '@shared/i18n'
import { FoldBar } from '@/components/ui/fold-bar'

/**
 * 设置 → 组件里的折叠条样张：回复收尾后过程收起来的那一行，点整行展开收起；
 * 下面一条是总结后面的协调小行，带一处失败
 */
export function FoldBarSpecimen() {
  const [open, setOpen] = useState(false)
  const [sub, setSub] = useState(false)
  return (
    <div className="flex w-full max-w-3xl flex-col gap-2">
      <FoldBar open={open} onToggle={() => setOpen(!open)} hint={open ? t('收起过程') : t('展开过程')}>
        <span className="truncate">{t('思考 12 秒 · 读取 6 个文件 · 编辑 3 个文件 · 运行 2 条命令')}</span>
      </FoldBar>
      {open && <p className="pl-6 text-body text-muted">{t('（展开后这里是思考、工具调用和中间的说明）')}</p>}
      <FoldBar open={sub} onToggle={() => setSub(!sub)} hint={sub ? t('收起过程') : t('展开过程')}>
        <span className="truncate">{t('派子对话 · 发消息')}</span>
        <span className="shrink-0 text-danger">{t('{n} 次失败', { n: 1 })}</span>
      </FoldBar>
    </div>
  )
}
