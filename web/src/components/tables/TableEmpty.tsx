import { useState } from 'react'
import { FolderOpen, Settings2, Table2 } from 'lucide-react'
import { t } from '@shared/i18n'
import { useData, useNav } from '@/lib/data'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/input'

/** 骨架里每列的宽度（像一张配置表：短的 ID、长的名字……） */
const COLS = [70, 110, 150, 130, 200, 120, 160]

/**
 * 打开一张表还在读的时候：先画工具栏、表头、几行淡色骨架，读完再换成真表格，
 * 不是一个孤零零的转圈（大表要读一两秒）
 */
export function TableSkeleton() {
  return (
    <div role="status" aria-label={t('正在打开表格')} className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
        {[64, 48, 80, 56].map((w, i) => (
          <span key={i} className="h-4 animate-pulse rounded bg-hover" style={{ width: w }} />
        ))}
      </div>
      <div className="flex shrink-0 border-b bg-panel">
        <span className="w-12 shrink-0" />
        {COLS.map((w, i) => (
          <span
            key={i}
            className="flex h-11 shrink-0 flex-col justify-center gap-1.5 border-r px-2"
            style={{ width: w }}
          >
            <span className="h-3 w-3/4 animate-pulse rounded bg-active" />
            <span className="h-2.5 w-1/2 animate-pulse rounded bg-hover" />
          </span>
        ))}
      </div>
      {Array.from({ length: 14 }, (_, r) => (
        <div key={r} className="flex shrink-0 border-b" style={{ opacity: 1 - r * 0.06 }}>
          <span className="w-12 shrink-0" />
          {COLS.map((w, i) => (
            <span key={i} className="flex h-[26px] shrink-0 items-center border-r px-2" style={{ width: w }}>
              <span
                className="h-2.5 animate-pulse rounded bg-hover"
                style={{ width: `${40 + ((r * 7 + i * 13) % 50)}%` }}
              />
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * 还没有哪个项目设了表格目录：一张引导卡。挑一个项目、一键打开它的「项目设置 → 表格」去选目录；
 * 设好后图标栏和这里就会列出那个项目的表格
 */
export function TablesSetupCard() {
  const { projects } = useData()
  const { go, openProject } = useNav()
  const [pick, setPick] = useState(projects[0]?.id ?? '')
  return (
    <main className="flex min-w-0 flex-1 items-center justify-center p-6">
      <section
        aria-label={t('设置表格目录')}
        className="flex w-full max-w-md flex-col gap-4 rounded-xl border bg-panel p-6 shadow-sm"
      >
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-text">
            <Table2 className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 className="text-title font-medium text-fg">{t('管理游戏配置表')}</h2>
            <p className="text-footnote text-subtle">{t('按目录浏览、搜索、检查和在线改 xlsx / csv 配置表')}</p>
          </div>
        </div>
        <ol className="flex flex-col gap-2 text-body text-muted">
          <li className="flex gap-2">
            <span className="text-subtle tabular-nums">1.</span>
            {t('在项目设置 →「表格」里选配置表所在的目录')}
          </li>
          <li className="flex gap-2">
            <span className="text-subtle tabular-nums">2.</span>
            {t('设置页里会显示找到了几个表格，可以按包含 / 排除筛')}
          </li>
          <li className="flex gap-2">
            <span className="text-subtle tabular-nums">3.</span>
            {t('回到这里，左边就是表格文件树')}
          </li>
        </ol>
        {projects.length ? (
          <div className="flex items-center gap-2">
            {projects.length > 1 && (
              <Select
                size="sm"
                value={pick}
                onChange={(e) => setPick(e.target.value)}
                options={projects.map((p) => ({ value: p.id, label: p.name }))}
                aria-label={t('项目')}
              />
            )}
            <Button size="sm" className="shrink-0" disabled={!pick} onClick={() => openProject(pick, 'tables')}>
              <Settings2 className="h-3.5 w-3.5" />
              {t('打开项目设置 → 表格')}
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="secondary" className="self-start" onClick={() => go({ page: 'home' })}>
            <FolderOpen className="h-3.5 w-3.5" />
            {t('先去建一个项目')}
          </Button>
        )}
      </section>
    </main>
  )
}
