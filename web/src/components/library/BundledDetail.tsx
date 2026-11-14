import { Check, Copy, Download, Loader2, Lock, Package, RefreshCw } from 'lucide-react'
import type { BundledSkill } from '@shared/library'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { useNav } from '@/lib/data'
import { useSkillUpdates } from '@/lib/skill-updates'
import { BUNDLED_STATUS_LABEL } from '@/lib/use-bundled-skills'
import { copyText } from '@/lib/copy-text'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Badge } from '@/components/ui/badge'
import { DetailEmpty, DetailHeader } from '@/components/layout/Detail'
import { categoryLabel } from '@/components/library/BundledSkills'
import { SkillBrowser } from '@/components/library/SkillBrowser'

/** 装到用户目录里的位置：所有 Agent 共用这一份 */
const SHARED_DIR = '~/.agents/skills'

/**
 * 自带 Skill 的详情页：名称、分类、说明、装在哪、文件结构和文件内容。
 * 内容只读——它是随面板版本发布的那一份（仓库 skills/），改了既会被下次更新覆盖、
 * 也不影响真正生效的 ~/.agents/skills 那份，所以这里只展示、不给编辑框。
 */
export function BundledDetail({
  item,
  busy,
  onInstall,
}: {
  item: BundledSkill
  /** 正在安装的项名（页面统一管，左栏的批量按钮也用这个） */
  busy: string
  onInstall: (names: string[], key: string, overwrite: boolean) => void
}) {
  const changed = item.status.shared === 'changed'
  const { openSettings } = useNav()
  // 部署到「分类/名字」的那份要在设置里更新：这里指过去，免得用户在这一页找不到
  const deployed = useSkillUpdates().deployed.includes(item.name)

  return (
    <main className="flex min-w-0 flex-1 flex-col md:h-full md:overflow-hidden">
      <DetailHeader
        compact
        quietSave
        leading={
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-text">
            <Package className="h-5 w-5" />
          </span>
        }
        title={item.name}
        meta={
          <>
            <Badge className="text-caption">{t('自带 Skill')}</Badge>
            {/* 和自带版本不一样（被改过）换成警告色，不靠虚线边框区分 */}
            <Badge tone={changed ? 'warning' : 'neutral'} className="gap-1.5 text-caption">
              {BUNDLED_STATUS_LABEL[item.status.shared]}
              {item.status.shared === 'same' ? (
                <Check className="h-3 w-3 text-success" />
              ) : item.status.shared === 'changed' ? (
                <RefreshCw className="h-3 w-3 text-warning" />
              ) : null}
            </Badge>
          </>
        }
        subtitle={item.description || t('没有说明')}
        save={{ status: 'idle', error: '' }}
        actions={
          <Button
            size="sm"
            variant={item.status.shared === 'missing' ? 'primary' : 'secondary'}
            onClick={() => onInstall([item.name], item.name, true)}
            disabled={!!busy || item.status.shared === 'same'}
            title={changed ? t('用自带的版本覆盖（你改过的内容会丢掉）') : undefined}
          >
            {busy === item.name ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : item.status.shared === 'missing' ? (
              <Download className="h-4 w-4" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {item.status.shared === 'same' ? t('已安装') : changed ? t('更新') : t('安装')}
          </Button>
        }
      />

      {/* 一行事实：分类、装在哪、只读说明。剩下的高度全给文件浏览区，不再限宽、不再有空框 */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 px-4 py-2.5 text-footnote md:px-8">
        <Fact label={t('分类')}>{categoryLabel(item.category)}</Fact>
        <Fact label={t('装在')}>
          <span className="font-mono">
            {SHARED_DIR}/{item.name}
          </span>
          <span className="text-subtle">{t('（所有 Agent 共用）')}</span>
          <IconButton
            icon={Copy}
            size="2xs"
            label={t('复制路径')}
            onClick={() => void copyText(`${SHARED_DIR}/${item.name}`, { done: t('已复制') })}
          />
        </Fact>
        <span className="flex items-center gap-1.5 text-subtle">
          <Lock className="h-3 w-3 shrink-0" />
          {t('随面板版本提供，只读；要改请复制一份到自己的技能目录')}
        </span>
        {deployed && (
          <span className="flex items-center gap-2 text-muted">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
            {t('这个技能还有一份部署在「设置 → 部署」，那份要覆盖部署一次才会更新。')}
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5 text-accent-text"
              onClick={() => openSettings('deploy')}
            >
              {t('去部署')}
            </Button>
          </span>
        )}
      </div>
      <SkillBrowser
        entries={item.tree?.entries ?? []}
        truncated={item.tree?.truncated}
        read={(path) => api.bundledEntry(item.name, path)}
        resetKey={item.name}
      />
    </main>
  )
}

/** 信息行里的一项：灰色的名、正常色的值 */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0 text-subtle">{label}</span>
      <span className="flex min-w-0 items-center gap-1 text-muted">{children}</span>
    </span>
  )
}

/** 没选中任何自带技能时的空态：告诉用户在左边点一项 */
export function BundledEmpty() {
  return (
    <DetailEmpty icon={<Package className="h-6 w-6" />} title={t('自带 Skill')}>
      <p>{t('在左边选一个技能，看它带哪些文件、装没装。')}</p>
    </DetailEmpty>
  )
}
