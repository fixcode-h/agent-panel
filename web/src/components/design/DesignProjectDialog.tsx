import { useEffect, useState } from 'react'
import * as D from '@radix-ui/react-dialog'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { DesignProject } from '@shared/design'
import { api } from '@/lib/api'
import { useData } from '@/lib/data'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DirPicker, useDirInfo } from '@/components/projects/DirPicker'
import { t } from '@shared/i18n'

/**
 * 新建或编辑 UI 设计的项目：只有名字和一个可选的本机目录（导出到项目目录时写到这里）。
 * 和 Agent 的项目是两套，互不影响。
 */
export function DesignProjectDialog({
  open,
  onOpenChange,
  project,
  onSaved,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  /** 有值时是编辑 */
  project?: DesignProject
  onSaved?: (p: DesignProject) => void
}) {
  const { setDesignProjects } = useData()
  const [name, setName] = useState('')
  const [dir, setDir] = useState('')
  const [busy, setBusy] = useState(false)
  const info = useDirInfo(dir)
  useEffect(() => {
    if (!open) return
    setName(project?.name ?? '')
    setDir(project?.path ?? '')
  }, [open, project])

  const save = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      const input = { name: name.trim(), path: dir.trim() }
      const p = project ? await api.updateDesignProject(project.id, input) : await api.createDesignProject(input)
      setDesignProjects((l) => (project ? l.map((x) => (x.id === p.id ? p : x)) : [...l, p]))
      onSaved?.(p)
      onOpenChange(false)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/50 animate-[fade-in_150ms_ease-out]" />
        <D.Content className="fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-[480px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line-strong bg-card p-6 shadow-2xl animate-[pop-in_160ms_ease-out] focus:outline-none">
          <D.Title className="text-[15px] font-semibold">{project ? t('编辑项目') : t('新建 UI 项目')}</D.Title>
          <D.Description className="mt-1.5 text-[13px] leading-relaxed text-muted">
            {t('UI 设计的项目和 Agent 的项目分开管理。一个项目对应一个游戏，里面放它的各个界面。')}
          </D.Description>
          <form
            className="mt-5 flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              void save()
            }}
          >
            <label className="flex flex-col gap-1.5">
              <span className="text-xs text-muted">{t('项目名称')}</span>
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('例如：暗夜远征')}
              />
            </label>
            <DirPicker
              value={dir}
              onChange={setDir}
              info={info}
              hint={t('可以不填。「导出到项目目录」会写到这个目录下的 UI 文件夹，一般选 UE 工程的目录。')}
            />
            <div className="mt-1 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => onOpenChange(false)}>
                {t('取消')}
              </Button>
              <Button type="submit" disabled={!name.trim() || busy}>
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {project ? t('保存') : t('创建')}
              </Button>
            </div>
          </form>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
