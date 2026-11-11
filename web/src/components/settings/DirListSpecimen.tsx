import { useState } from 'react'
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { t } from '@shared/i18n'
import { DirList } from '@/components/projects/DirList'

/** 样例：一个找到了表格的目录、一个找不到的（演示数据不翻译） */
const SAMPLE = ['Config', 'Designer/Excle']

/** 设置 → 组件里的目录列表：项目设置「表格目录」用的就是它；「浏览」「添加目录」打开本机目录选择器 */
export function DirListSpecimen() {
  const [dirs, setDirs] = useState(SAMPLE)
  return (
    <div className="w-full max-w-xl">
      <DirList
        value={dirs}
        onChange={setDirs}
        base="~/code/game-client"
        placeholder={t('相对项目目录，或绝对路径')}
        status={(d) =>
          d.trim() === 'Config' ? (
            <span className="flex items-center gap-1.5 text-caption text-muted">
              <CheckCircle2 className="h-3 w-3 text-success" />
              {t('{n} 个表格', { n: 42 })}
            </span>
          ) : d.trim() ? (
            <span className="flex items-center gap-1.5 text-caption text-warning">
              <AlertTriangle className="h-3 w-3" />
              {t('找不到这个目录：{full}', { full: `~/code/game-client/${d.trim()}` })}
            </span>
          ) : null
        }
      />
    </div>
  )
}
