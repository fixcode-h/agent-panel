import { TableProperties } from 'lucide-react'
import { useNav } from '@/lib/data'
import { ModalButton } from '@/components/ui/modal'
import type { SheetClaim } from '@/plugins/sdk'

/**
 * 文件弹窗标题栏上插件认领的表格的跳转按钮（表格插件的「在表格页打开」）：
 * leave 先收拾弹窗（有没保存的改动时问一句并返回 false，不跳）；再去插件的整页，带上正在看的工作表
 */
export function SheetClaimButton({
  claim,
  sheet,
  leave,
}: {
  claim: (SheetClaim & { plugin: string }) | undefined
  sheet: string
  leave: () => boolean
}) {
  const { go } = useNav()
  const open = claim?.open
  if (!claim || !open) return null
  return (
    <ModalButton
      icon={TableProperties}
      label={open.label}
      onClick={() => leave() && go({ page: 'plugin', id: claim.plugin, sub: open.page, msg: open.path(sheet) })}
    />
  )
}
