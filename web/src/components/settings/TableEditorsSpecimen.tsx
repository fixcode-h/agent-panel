import { useState } from 'react'
import { t } from '@shared/i18n'
import type { EnumOption, ColInfo } from '@shared/table-struct'
import { Button } from '@/components/ui/button'
import { EnumPicker } from '@/components/tables/EnumPicker'
import { ListEditor } from '@/components/tables/ListEditor'
import { ProblemsBar } from '@/components/tables/ProblemsBar'

/** 样例数据：演示数据不翻译 */
const MOUNT: EnumOption[] = [
  { name: 'FloorMirror', value: '1', desc: '落地' },
  { name: 'WallMirror', value: '2', desc: '挂墙' },
  { name: 'TabletopDecor', value: '3', desc: '桌面' },
]
const ROLES: EnumOption[] = [
  { name: '1001', desc: '艾琳' },
  { name: '1002', desc: '洛克' },
  { name: '1003', desc: '米娅' },
]
const INFOS = [
  { col: 0, field: 'ID' },
  { col: 1, field: 'MountType' },
  { col: 2, field: 'TriggerState' },
] as ColInfo[]
const PROBLEMS = [
  { r: 7, c: 1, msg: '「CeilingLamp」不是 HomeDecorationMountType 里的值' },
  { r: 9, c: 2, msg: '不能大于 1' },
  { r: 12, c: 0, msg: '主键重复：第 6 行也是「1」' },
]

/**
 * 设置 → 组件里表格页的格子编辑器：枚举 / 引用下拉、repeated 列表编辑、检查结果。
 * 下拉和表格页里一样是弹出层，点按钮打开；外观跟着「弹出菜单」「输入框」的微调走
 */
export function TableEditorsSpecimen() {
  const [open, setOpen] = useState<'enum' | 'list' | null>(null)
  const [mount, setMount] = useState('WallMirror')
  const [roles, setRoles] = useState('1001;1003')
  const cell = 'relative h-8 w-56 rounded-sm border bg-(--c-modal-bg) px-2 font-mono text-footnote leading-8'
  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-wrap items-start gap-6">
        <div className="flex flex-col gap-1.5">
          <span className="text-caption text-subtle">EnumPicker</span>
          <div className={cell}>
            {open === 'enum' ? (
              <EnumPicker
                init={mount}
                options={MOUNT}
                title="HomeDecorationMountType"
                onAdd={() => {}}
                onDone={(v) => {
                  if (v !== null) setMount(v)
                  setOpen(null)
                }}
              />
            ) : (
              mount
            )}
          </div>
          <Button size="sm" variant="ghost" className="self-start" onClick={() => setOpen('enum')}>
            {t('打开下拉')}
          </Button>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-caption text-subtle">ListEditor</span>
          <div className={cell}>
            {open === 'list' ? (
              <ListEditor
                init={roles}
                sep=";"
                options={ROLES}
                title="data/character/C_Character.xlsx#ID"
                onDone={(v) => {
                  if (v !== null) setRoles(v)
                  setOpen(null)
                }}
              />
            ) : (
              roles
            )}
          </div>
          <Button size="sm" variant="ghost" className="self-start" onClick={() => setOpen('list')}>
            {t('打开列表编辑')}
          </Button>
        </div>
      </div>
      {/* 表格页里它在表格底下、最多占三分之一高；这里外框不定高，整条都露出来 */}
      <div className="flex flex-col overflow-hidden rounded-lg border">
        <ProblemsBar problems={PROBLEMS} infos={INFOS} onPick={() => {}} onClose={() => {}} />
      </div>
    </div>
  )
}
