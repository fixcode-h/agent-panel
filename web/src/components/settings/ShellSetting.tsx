import { useEffect, useState } from 'react'
import { toast } from '@/lib/toast'
import { Loader2, RefreshCw } from 'lucide-react'
import type { Settings } from '@shared/schema'
import { pickShell, recommendedShell, SHELL_LABEL, type ShellReport } from '@shared/shells'
import { t } from '@shared/i18n'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/input'
import { Row } from './parts'

/**
 * 设置「常规」里的命令行环境：只在 Windows 上显示。
 * 不单独列「自动」：预选推荐的那个并标「（默认）」，选回它时不单独记，以后装了 Git Bash / WSL 会跟着换
 */
export function ShellSetting({
  value,
  onChange,
}: {
  value: Settings['shell']
  onChange: (v: Settings['shell']) => void
}) {
  const [report, setReport] = useState<ShellReport | null>(null)
  const [checking, setChecking] = useState(false)
  const load = async (fresh = false) => {
    setChecking(true)
    try {
      setReport(await api.shells(fresh))
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setChecking(false)
    }
  }
  useEffect(() => {
    void load()
  }, [])
  if (!report || report.platform !== 'win32') return null
  const rec = recommendedShell(report)
  const cur = pickShell(report, value)
  const distros = cur.id === 'wsl' ? (cur.distros ?? []) : []
  return (
    <Row
      title={t('命令行环境')}
      desc={t(
        '面板替角色跑整行命令时用的 shell：后台命令，以及合并时编译里环境为「自动」的测试步骤。默认用 Git Bash（Windows 路径可以直接用），没有 Git Bash 时用 WSL，再没有用 cmd。',
      )}
    >
      {/* 发行版放在第二行：两个下拉框并排时右栏放不下，会把发行版名字截断 */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1.5">
          <Select
            aria-label={t('命令行环境')}
            value={cur.id}
            onChange={(e) =>
              onChange({ ...value, kind: e.target.value === rec.id ? '' : (e.target.value as typeof value.kind) })
            }
            className="w-48"
            options={report.shells.map((s) => ({
              value: s.id,
              label: `${SHELL_LABEL[s.id]}${s.id === rec.id ? t('（默认）') : ''}`,
            }))}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('重新检测')}
            title={t('重新检测（刚装了 WSL 或 Git 时用）')}
            disabled={checking}
            onClick={() => void load(true)}
          >
            {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>
        {distros.length > 1 && (
          <Select
            aria-label={t('WSL 发行版')}
            value={cur.distro || distros[0]}
            onChange={(e) => onChange({ ...value, wslDistro: e.target.value === distros[0] ? '' : e.target.value })}
            className="w-60"
            options={distros.map((d, i) => ({ value: d, label: i === 0 ? `${d}${t('（默认）')}` : d }))}
          />
        )}
      </div>
    </Row>
  )
}
