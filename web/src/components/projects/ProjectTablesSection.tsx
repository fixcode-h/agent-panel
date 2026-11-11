import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowUpRight, CheckCircle2, FileSpreadsheet, Loader2 } from 'lucide-react'
import { t } from '@shared/i18n'
import { TABLE_EXCLUDE, TABLE_INCLUDE, TablesConfig, tablesOn, type TableRoot } from '@shared/tables'
import type { Project } from '@shared/schema'
import { tablesApi, type TablesProbe } from '@/lib/tables-api'
import { useNav } from '@/lib/data'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FormSection, Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { TablesAnalyze, useTablesAnalysisPending } from '@/components/tables/TablesAnalyze'
import { TabBar, TabItem } from '@/components/ui/tab-bar'
import { DirList } from './DirList'
import { ProjectTablesEnums, ProjectTablesHeader } from './ProjectTablesHeader'
import { ProjectTablesExports } from './ProjectTablesExports'
import { ProjectTablesRules } from './ProjectTablesRules'

/** 「表格」设置的子页：一页太长，按要做的事分开 */
type Sub = 'dirs' | 'header' | 'enums' | 'rules' | 'exports' | 'ai'

/** 常见的表格目录写法：点一下加一行 */
const COMMON_DIRS = ['Config', 'Designer/Excel', 'Design/Tables', 'Content/DataTables']

/**
 * 项目设置的「表格」：表格目录（一个目录一行，可以用目录选择器选，项目目录外的也行）、包含 / 排除、结构信息存在哪、只读。
 * 和其它设置一样点「确认」才保存；改目录时马上按还没保存的配置找一遍，每行下面显示找到几个表格。
 * 下面的「AI 分析表格风格」直接读写结构文件，不走「确认」（结构文件不在项目设置里）
 */
export function ProjectTablesSection({
  value,
  onChange,
  project,
  base,
  path,
}: {
  value: TablesConfig | undefined
  onChange: (v: TablesConfig | undefined) => void
  project?: Project
  /** 项目目录展开后的绝对路径：选到项目目录里的文件夹时写成相对路径 */
  base: string
  /** 设置里现在填的项目目录（可能还没保存） */
  path: string
}) {
  const cfg = TablesConfig.parse(value ?? {})
  // 列表里的行（含正在输入、还空着的）；保存进配置的是去掉空行的
  const [rows, setRows] = useState<string[]>(() => (cfg.dirs.length ? cfg.dirs : ['']))
  const patch = (p: Partial<TablesConfig>) => {
    const next = { ...cfg, ...p }
    // 一个目录都没有时整项去掉：项目文件里不留空壳
    onChange(next.dirs.length ? next : undefined)
  }
  const setDirs = (list: string[]) => {
    setRows(list)
    patch({
      dirs: list
        .map((s) =>
          s
            .trim()
            .replace(/\\/g, '/')
            .replace(/(.)\/+$/, '$1'),
        )
        .filter(Boolean),
    })
  }
  const probe = useProbe(project?.id, path, value)
  const saved = project && tablesOn(project.tables) && JSON.stringify(project.tables) === JSON.stringify(value)
  const rootOf = (d: string) => {
    const key = d
      .trim()
      .replace(/\\/g, '/')
      .replace(/(.)\/+$/, '$1')
    return typeof probe === 'object' && probe ? probe.roots.find((r) => r.dir === key) : undefined
  }
  const unused = COMMON_DIRS.filter((d) => !rows.some((r) => r.trim() === d))
  const [sub, setSub] = useState<Sub>('dirs')
  const aiDot = useTablesAnalysisPending(project?.id)
  const subs: { id: Sub; label: string }[] = [
    { id: 'dirs', label: t('目录') },
    { id: 'header', label: t('表头') },
    { id: 'enums', label: t('枚举') },
    { id: 'rules', label: t('校验') },
    { id: 'exports', label: t('导表') },
    { id: 'ai', label: t('AI 分析') },
  ]
  /** 目录、导表在项目设置里，跟着「确认」；表头、枚举、校验、AI 分析写结构文件，改了就存 */
  const viaConfirm = sub === 'dirs' || sub === 'exports'
  return (
    <>
      <TabBar label={t('表格设置')} variant="underline" className="-mt-1">
        {subs.map((s) => (
          <TabItem
            key={s.id}
            active={sub === s.id}
            onSelect={() => setSub(s.id)}
            tag={
              s.id === 'ai' && aiDot ? (
                <span aria-label={t('有新的分析结果')} className="h-1.5 w-1.5 rounded-full bg-danger" />
              ) : undefined
            }
          >
            {s.label}
          </TabItem>
        ))}
      </TabBar>
      {sub === 'dirs' && (
        <FormSection title={t('表格目录')}>
          <Field
            label={t('目录')}
            tip={t(
              '这些目录里（含多层子目录）的表格会列在表格页左侧。可以写相对项目目录的路径，也可以选项目目录外的文件夹（比如策划的表格仓库）。',
            )}
          >
            <DirList
              value={rows}
              onChange={setDirs}
              base={base}
              placeholder={t('相对项目目录，或绝对路径')}
              addLabel={t('添加表格目录')}
              browseTitle={t('选择表格目录')}
              status={(d) => (d.trim() ? <RootStatus root={rootOf(d)} pending={probe === null} /> : null)}
            />
          </Field>
          {unused.length > 0 && rows.every((r) => !r.trim()) && (
            <div className="flex flex-wrap items-center gap-1.5 text-footnote text-subtle">
              {t('常见写法：')}
              {unused.map((d) => (
                <Button
                  key={d}
                  size="sm"
                  variant="ghost"
                  className="font-mono"
                  onClick={() => setDirs([...rows.filter((r) => r.trim()), d])}
                >
                  {d}
                </Button>
              ))}
            </div>
          )}
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
          {project && tablesOn(cfg) && <ProbeSummary project={project} probe={probe} saved={!!saved} />}
        </FormSection>
      )}

      {sub === 'header' && (
        <FormSection title={t('表头')}>
          {saved && project ? (
            <ProjectTablesHeader projectId={project.id} />
          ) : (
            <p className="text-footnote leading-relaxed text-subtle">
              {t('设好表格目录并点「确认」保存后，可以设整个项目的表头从第几行开始、共几行、每行是什么。')}
            </p>
          )}
        </FormSection>
      )}

      {sub === 'enums' && !(saved && project) && <NeedSave />}
      {sub === 'enums' && saved && project && (
        <FormSection title={t('通用枚举')}>
          <p className="text-footnote leading-relaxed text-subtle">
            {t('整个项目所有表格共用：列的类型写了同名类型，或在「列结构」里选了它，改格子时就是下拉，填错会标红。')}
          </p>
          <ProjectTablesEnums projectId={project.id} />
        </FormSection>
      )}

      {sub === 'rules' && !(saved && project) && <NeedSave />}
      {sub === 'rules' && saved && project && (
        <FormSection title={t('校验')}>
          <ProjectTablesRules projectId={project.id} />
        </FormSection>
      )}

      {sub === 'exports' && !tablesOn(cfg) && <NeedSave />}
      {sub === 'exports' && tablesOn(cfg) && (
        <FormSection title={t('导表脚本')}>
          <p className="text-footnote leading-relaxed text-subtle">
            {t('表格页的「导表」按钮和文件树右键里执行。命令里写占位，执行时才换成表格的真实路径。')}
          </p>
          <ProjectTablesExports
            value={cfg.exports}
            onChange={(exports) => patch({ exports })}
            sample={(typeof probe === 'object' && probe?.sample[0]) || 'Config/Item.xlsx'}
            base={base}
          />
        </FormSection>
      )}

      {sub === 'dirs' && (
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
      )}

      {sub === 'ai' && (
        <FormSection title={t('AI 分析表格风格')}>
          {saved && project ? (
            <TablesAnalyze projectId={project.id} projectName={project.name} />
          ) : (
            <p className="text-footnote leading-relaxed text-subtle">
              {t(
                '设好表格目录并点「确认」保存后，可以让 AI 读几张表，总结表头有几行、每行是什么、哪些列是枚举或引用。',
              )}
            </p>
          )}
        </FormSection>
      )}

      <p className="flex items-center gap-1.5 border-t pt-3 text-caption text-subtle">
        {viaConfirm ? (
          t('这一页跟着项目设置下面的「确认」一起保存。')
        ) : (
          <>
            <CheckCircle2 className="h-3 w-3 text-success" />
            {t('这一页写进表格结构文件，改了就单独保存，不用点「确认」。')}
          </>
        )}
      </p>
    </>
  )
}

/** 结构文件那几页：表格目录还没保存时先说明 */
function NeedSave() {
  return (
    <p className="text-footnote leading-relaxed text-subtle">{t('先在「目录」里设好表格目录，并点「确认」保存。')}</p>
  )
}

/**
 * 按还没保存的配置找一遍表格（停手 400ms 后找）：null = 正在找，字符串 = 出错，没项目 id（新建项目）时不找。
 * 项目目录也用设置里现在填的，改了项目目录不用先保存
 */
function useProbe(projectId: string | undefined, path: string, value: TablesConfig | undefined) {
  const [probe, setProbe] = useState<TablesProbe | string | null | undefined>(undefined)
  const key = JSON.stringify([projectId, path, value])
  useEffect(() => {
    if (!projectId || !value || !tablesOn(value)) return setProbe(undefined)
    let live = true
    setProbe(null)
    const timer = setTimeout(() => {
      tablesApi
        .probe(projectId, path, value)
        .then((r) => live && setProbe(r))
        .catch((e) => live && setProbe((e as Error).message))
    }, 400)
    return () => {
      live = false
      clearTimeout(timer)
    }
    // 按配置内容变化重找（value 每次渲染都是新对象）
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return probe
}

/** 一个目录下面的一行：找到几个表格 / 找不到（给出实际找的位置，路径写错一眼能看出来） */
function RootStatus({ root, pending }: { root: TableRoot | undefined; pending: boolean }) {
  if (pending || !root)
    return pending ? (
      <span className="flex items-center gap-1.5 text-caption text-subtle">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t('正在查找表格…')}
      </span>
    ) : null
  if (!root.found)
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-caption text-warning">
        <AlertTriangle className="h-3 w-3 shrink-0" />
        <span className="truncate" title={root.full}>
          {root.full ? t('找不到这个目录：{full}', { full: root.full }) : t('路径不能带 ..，项目目录外的请写绝对路径')}
        </span>
      </span>
    )
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-caption text-muted">
      <CheckCircle2 className={root.files ? 'h-3 w-3 shrink-0 text-success' : 'h-3 w-3 shrink-0 text-warning'} />
      <span className="shrink-0">
        {root.files ? t('{n} 个表格', { n: root.files }) : t('目录在，但里面没有符合「包含」的表格')}
      </span>
      <span className="truncate text-subtle" title={root.full}>
        · {root.full}
      </span>
    </span>
  )
}

/** 合计：一共找到多少个表格、前几个是什么；保存后能直接去表格页 */
function ProbeSummary({
  project,
  probe,
  saved,
}: {
  project: Project
  probe: TablesProbe | string | null | undefined
  saved: boolean
}) {
  const { go } = useNav()
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-(--c-row-radius) bg-sel/60 px-3 py-2 text-footnote text-muted">
      <FileSpreadsheet className="h-4 w-4 text-subtle" />
      {probe === null || probe === undefined ? (
        t('正在查找表格…')
      ) : typeof probe === 'string' ? (
        <span className="text-danger">{probe}</span>
      ) : (
        <>
          <span>
            {t('一共 {n} 个表格文件', { n: probe.files })}
            {probe.truncated && t('（太多了，只列出前一部分）')}
          </span>
          {probe.sample.length > 0 && (
            <span className="min-w-0 truncate font-mono text-caption text-subtle" title={probe.sample.join('\n')}>
              {probe.sample.map((p) => p.slice(p.lastIndexOf('/') + 1)).join('、')}
              {probe.files > probe.sample.length && ' …'}
            </span>
          )}
        </>
      )}
      {saved ? (
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => go({ page: 'tables', id: project.id })}>
          {t('打开表格页')}
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Button>
      ) : (
        <span className="ml-auto text-caption text-subtle">{t('点「确认」保存后，侧栏会多一个「表格」入口。')}</span>
      )}
    </div>
  )
}
