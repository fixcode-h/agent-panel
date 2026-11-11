import { useEffect, useState } from 'react'
import { ArrowUpRight, FileSpreadsheet } from 'lucide-react'
import { t } from '@shared/i18n'
import { TABLE_EXCLUDE, TABLE_INCLUDE, TablesConfig, tablesOn } from '@shared/tables'
import type { Project } from '@shared/schema'
import { tablesApi } from '@/lib/tables-api'
import { useNav } from '@/lib/data'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FormSection, Input, Textarea } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'

/**
 * 项目设置的「表格」：表格目录、包含 / 排除、结构信息存在哪、只读。
 * 和其它设置一样点「确认」才保存；设了目录后侧栏多一个「表格」入口。
 * 下面的「AI 分析表格风格」直接读写结构文件，不走「确认」（结构文件不在项目设置里）
 */
export function ProjectTablesSection({
  value,
  onChange,
  project,
}: {
  value: TablesConfig | undefined
  onChange: (v: TablesConfig | undefined) => void
  project?: Project
}) {
  const cfg = TablesConfig.parse(value ?? {})
  const [dirsText, setDirsText] = useState(cfg.dirs.join('\n'))
  const patch = (p: Partial<TablesConfig>) => {
    const next = { ...cfg, ...p }
    // 一个目录都没有时整项去掉：项目文件里不留空壳
    onChange(next.dirs.length ? next : undefined)
  }
  const saved = project && tablesOn(project.tables) && JSON.stringify(project.tables) === JSON.stringify(value)
  return (
    <>
      <FormSection title={t('表格目录')}>
        <Field
          label={t('目录（一行一个，相对项目目录）')}
          tip={t(
            '这些目录里（含子目录）的表格会列在表格页左侧。常见的写法：Config、Design/Tables、Content/DataTables。',
          )}
        >
          <Textarea
            rows={3}
            value={dirsText}
            placeholder={'Config\nDesign/Tables'}
            onChange={(e) => {
              setDirsText(e.target.value)
              patch({
                dirs: e.target.value
                  .split('\n')
                  .map((s) => s.trim().replace(/\\/g, '/').replace(/\/+$/, ''))
                  .filter(Boolean),
              })
            }}
            className="font-mono text-footnote"
          />
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={t('包含')} tip={t('逗号分隔的通配，比如 *.xlsx, *.csv；带 / 的按相对路径比')}>
            <Input
              value={cfg.include}
              placeholder={TABLE_INCLUDE}
              onChange={(e) => patch({ include: e.target.value })}
              className="font-mono text-footnote"
            />
          </Field>
          <Field label={t('排除')} tip={t('默认跳过 Excel / WPS 打开文件时留下的 ~$ 锁文件')}>
            <Input
              value={cfg.exclude}
              placeholder={TABLE_EXCLUDE}
              onChange={(e) => patch({ exclude: e.target.value })}
              className="font-mono text-footnote"
            />
          </Field>
        </div>
        {project && <TablesProbe project={project} saved={!!saved} />}
      </FormSection>

      <FormSection title={t('结构信息')}>
        <Field
          label={t('存放位置')}
          tip={t(
            '表头规则、枚举、列的引用和取值范围这些结构信息永远不写进表格。存在项目目录里可以跟着版本控制给团队共用；只存本机就不会出现在项目目录里。',
          )}
        >
          <div>
            <Segmented
              label={t('存放位置')}
              value={cfg.store}
              onChange={(v) => patch({ store: v as TablesConfig['store'] })}
              options={[
                { id: 'project', label: t('项目目录 .agentpanel/tables（推荐）') },
                { id: 'data', label: t('只存本机') },
              ]}
            />
          </div>
        </Field>
        <Checkbox
          checked={cfg.readOnly}
          onChange={(v) => patch({ readOnly: v })}
          label={t('只读')}
          tip={t('表格页只能看、搜索、筛选和对比，不能改单元格。')}
        />
      </FormSection>

      <FormSection title={t('AI 分析表格风格')}>
        {saved ? null : (
          <p className="text-footnote leading-relaxed text-subtle">
            {t('设好表格目录并点「确认」保存后，可以让 AI 读几张表，总结表头有几行、每行是什么、哪些列是枚举或引用。')}
          </p>
        )}
      </FormSection>
    </>
  )
}

/** 保存过的配置找到了多少个表格；没保存的改动提示先确认 */
function TablesProbe({ project, saved }: { project: Project; saved: boolean }) {
  const { go } = useNav()
  const [found, setFound] = useState<{ n: number; missing: string[]; truncated?: boolean } | string | null>(null)
  useEffect(() => {
    if (!saved) return
    let live = true
    tablesApi
      .list(project.id)
      .then((r) => live && setFound({ n: r.files.length, missing: r.missing, truncated: r.truncated }))
      .catch((e) => live && setFound((e as Error).message))
    return () => {
      live = false
    }
  }, [project.id, saved])
  if (!saved) return <p className="text-footnote text-subtle">{t('点「确认」保存后，侧栏会多一个「表格」入口。')}</p>
  return (
    <div className="flex flex-wrap items-center gap-2 text-footnote text-muted">
      <FileSpreadsheet className="h-4 w-4 text-subtle" />
      {found === null ? (
        t('正在查找表格…')
      ) : typeof found === 'string' ? (
        <span className="text-danger">{found}</span>
      ) : (
        <>
          {t('找到 {n} 个表格文件', { n: found.n })}
          {found.truncated && t('（太多了，只列出前一部分）')}
          {found.missing.length > 0 && (
            <span className="text-warning">{t('找不到目录：{dirs}', { dirs: found.missing.join('、') })}</span>
          )}
        </>
      )}
      <Button size="sm" variant="ghost" className="ml-auto" onClick={() => go({ page: 'tables', id: project.id })}>
        {t('打开表格页')}
        <ArrowUpRight className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}
