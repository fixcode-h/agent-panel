import { useRef, useState } from 'react'
import { FileArchive, Loader2 } from 'lucide-react'
import { compareVersions, type LocalPackageInfo } from '@shared/version'
import { discardLocalPackage, installLocalPackage, uploadLocalPackage } from '@/lib/app-update'
import { toast } from '@/lib/toast'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'

const OS_NAME: Record<string, string> = { win: 'Windows', mac: 'macOS', linux: 'Linux' }

/**
 * 「版本更新」里的「用本地安装包更新」：连不上 GitHub、或者已经手动下载好包时用。
 * 选好文件先交给服务端检查（格式、是不是这个系统的包），拿到包里的版本再请用户确认；
 * 确认后和在线更新走同一套流程，进度显示在上面同一个进度条里
 */
export function LocalPackageButton({ current, disabled }: { current: string; disabled: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  const [checking, setChecking] = useState(false)
  const [pkg, setPkg] = useState<(LocalPackageInfo & { name: string }) | null>(null)

  const pick = async (file: File | undefined) => {
    // 清掉选择：同一个文件再选一次也要触发 onChange
    if (input.current) input.current.value = ''
    if (!file) return
    setChecking(true)
    try {
      setPkg({ ...(await uploadLocalPackage(file)), name: file.name })
    } catch (e) {
      toast.error(t('这个安装包不能用：{error}', { error: (e as Error).message }))
    } finally {
      setChecking(false)
    }
  }

  const cmp = pkg ? compareVersions(pkg.version, current) : 0
  const version = pkg?.version ?? ''
  const newer = cmp > 0
  const older = cmp < 0
  const confirmText = newer ? t('更新') : older ? t('切换') : t('重新安装')
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".zip,.gz,.tgz,application/zip,application/gzip"
        className="hidden"
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      <Button
        size="sm"
        variant="ghost"
        className="w-fit"
        disabled={disabled || checking}
        onClick={() => input.current?.click()}
        title={t('选择已经下载到本机的安装包来更新，连不上 GitHub 时也能用')}
      >
        {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileArchive className="h-3.5 w-3.5" />}
        {checking ? t('正在检查安装包…') : t('用本地安装包更新')}
      </Button>
      <ConfirmDialog
        open={!!pkg}
        onOpenChange={(o) => {
          if (o || !pkg) return
          void discardLocalPackage(pkg.id)
          setPkg(null)
        }}
        title={
          newer
            ? t('更新到 v{version}？', { version })
            : older
              ? t('切换到较旧的 v{version}？', { version })
              : t('重新安装 v{version}？', { version })
        }
        description={
          <span className="flex flex-col gap-2">
            <span className="font-mono text-xs break-all text-subtle">
              {pkg?.name}
              {pkg?.os ? ` · ${OS_NAME[pkg.os] ?? pkg.os}` : ''}
            </span>
            <span>
              {older
                ? t(
                    '会用这个较旧的包替换当前程序，然后自动重启。旧版本可能读不懂新版本写的部分数据，建议先备份 data 目录。',
                  )
                : t(
                    '会用这个包替换当前程序，然后自动重启，data 目录里的数据会保留。有任务在执行时，会等所有任务结束后再替换。',
                  )}
            </span>
          </span>
        }
        confirmText={confirmText}
        onConfirm={() => {
          if (!pkg) return
          const id = pkg.id
          setPkg(null)
          installLocalPackage(id).catch((e) => toast.error((e as Error).message))
        }}
      />
    </>
  )
}
