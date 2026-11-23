import type { ComponentType, ReactNode } from 'react'
import { t } from '@shared/i18n'
import type { CompName } from '@shared/component-style'
import { BackgroundStatus } from '@/components/ui/background-status'

/** 侧栏底部的后台状态样张：建文件索引时的进度、不知道总数时的不定进度、出错（从 ComponentsSection 挪出，那边函数到上限了） */
export function BackgroundStatusSpecimen({
  Specimen,
}: {
  Specimen: ComponentType<{ name: string; tune?: CompName[]; children: ReactNode }>
}) {
  return (
    <Specimen name="BackgroundStatus" tune={['nav', 'progress']}>
      <div className="flex w-64 flex-col gap-2 rounded-lg bg-rail px-2.5 py-2.5">
        <BackgroundStatus label={t('正在建立文件索引')} detail="42%" value={42} max={100} />
        <BackgroundStatus label={t('正在建立文件索引')} detail={t('{n} 个文件', { n: '3.2 万' })} />
        <BackgroundStatus error label={t('文件索引出错，点开看原因')} />
      </div>
    </Specimen>
  )
}
