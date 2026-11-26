import type { CustomTool, ToolRole } from '@shared/custom-tools/schema'
import { fileParamOf } from '@shared/custom-tools/match'
import { t } from '@shared/i18n'
import { ChipListInput } from '@/components/ui/chip-list-input'
import { Field, Select } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'

type Kind = ToolRole['kind'] | ''

/**
 * 编辑抽屉的「用途」页（ADR 0086）：工具在能力路由里管什么——校验（改完对得上的文件面板自己跑、只推报错）、
 * 编译（UE 编译命令改用它），以及它能顶替哪些程序（Agent 自己跑 luac 时改道到这里）。不选就是普通工具
 */
export function RoleTab({ d, set }: { d: CustomTool; set: (role: CustomTool['role']) => void }) {
  const r = d.role
  const patch = (p: Partial<ToolRole>) => r && set({ ...r, ...p })
  const pathParams = d.params.filter((p) => p.type === 'path' || p.type === 'string')
  return (
    <div className="flex flex-col gap-3">
      <Field label={t('用途')} hint={t('校验和编译会接进工具路由：面板按它自动检查、改道')}>
        <Select
          value={r?.kind ?? ''}
          onChange={(e) => {
            const kind = e.target.value as Kind
            set(
              kind
                ? { kind, paths: r?.paths ?? [], replaces: r?.replaces ?? [], listFile: r?.listFile ?? false }
                : undefined,
            )
          }}
          options={[
            { value: '', label: t('普通工具（由 Agent 自己调）') },
            { value: 'verify', label: t('校验：改完对得上的文件后面板自己跑') },
            { value: 'build', label: t('编译：Agent 自己拼编译命令时改用它') },
          ]}
        />
      </Field>
      {r?.kind === 'verify' && d.effect !== 'read' && (
        <p className="text-footnote text-danger">{t('校验工具要是只读的：在「影响和输出」里把影响改成只读。')}</p>
      )}
      {r?.kind === 'verify' && (
        <>
          <Field label={t('改了哪些文件要查')} hint={t('相对项目根，** 表示任意层；只把报错推给 Agent，没报错不打扰')}>
            <ChipListInput
              value={r.paths}
              onChange={(v) => patch({ paths: v })}
              label={t('改了哪些文件要查')}
              placeholder="**/*.lua"
            />
          </Field>
          <Field label={t('改过的文件填进哪个参数')} hint={t('不选时用第一个路径参数；没有参数就不带文件跑一次')}>
            <Select
              value={r.arg ?? ''}
              onChange={(e) => patch({ arg: e.target.value || undefined })}
              options={[
                {
                  value: '',
                  label: t('自动（{name}）', { name: fileParamOf({ ...d, role: undefined }) ?? t('不带文件') }),
                },
                ...pathParams.map((p) => ({ value: p.name, label: p.label ? `${p.name}（${p.label}）` : p.name })),
              ]}
            />
          </Field>
          <label className="flex items-center gap-2 text-body">
            <Switch
              checked={r.listFile}
              onCheckedChange={(v) => patch({ listFile: v })}
              aria-label={t('写成清单文件一次查完')}
            />
            {t('写成清单文件一次查完')}
            <span className="text-footnote text-subtle">{t('一行一个路径；不开时按文件一个个跑')}</span>
          </label>
        </>
      )}
      {r && (
        <Field label={t('顶替的程序')} hint={t('Agent 自己跑这些程序时，改道模式下改走这个工具；只写程序名，如 luac')}>
          <ChipListInput
            value={r.replaces}
            onChange={(v) => patch({ replaces: v.map((x) => x.trim().toLowerCase()) })}
            label={t('顶替的程序')}
            placeholder="luac"
          />
        </Field>
      )}
    </div>
  )
}
