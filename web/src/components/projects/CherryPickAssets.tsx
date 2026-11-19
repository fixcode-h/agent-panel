import { useState } from 'react'
import { t } from '@shared/i18n'
import { DEFAULT_ASSET_EXTS, parseAssetExts } from '@shared/projects/cherry-pick-assets'
import { Button } from '@/components/ui/button'
import { Field, Textarea } from '@/components/ui/input'

/**
 * 项目设置里 cherry-pick 的「资源文件类型」（用户 2026-11-19 定）：这些扩展名的文件冲突时不解冲突，
 * 直接用搬过去的版本覆盖目标；清单外的二进制文件也一样。没改过时显示默认清单，存的是 undefined
 */
export function CherryPickAssets({
  value,
  onChange,
}: {
  value: string[] | undefined
  onChange: (v: string[] | undefined) => void
}) {
  // 输入框留原文，打字时不被规整（逗号、空格）打断；失去焦点时换成规整后的清单
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? (value ?? DEFAULT_ASSET_EXTS).join(' ')
  return (
    <Field
      label={t('资源文件类型')}
      hint={t(
        '这些扩展名的文件 cherry-pick 冲突时不解冲突，直接用搬过去的版本覆盖目标；不在清单里的二进制文件也一样。代码等文本文件冲突时由 Agent 解。用空格或逗号分隔。',
      )}
    >
      <Textarea
        aria-label={t('资源文件类型')}
        className="min-h-16 font-mono text-xs"
        value={shown}
        onChange={(e) => {
          setDraft(e.target.value)
          onChange(parseAssetExts(e.target.value))
        }}
        onBlur={() => setDraft(null)}
      />
      {value && (
        <div>
          <Button
            variant="link"
            tone="muted"
            onClick={(e) => {
              // 在 label 里：不阻止的话点击会把焦点送回输入框
              e.preventDefault()
              setDraft(null)
              onChange(undefined)
            }}
          >
            {t('恢复默认')}
          </Button>
        </div>
      )}
    </Field>
  )
}
