import { t } from '@shared/i18n'

/** 1 MB（字节）：内存统计统一按字节传，显示时才换算 */
export const MB = 1024 * 1024

/** 内存大小：MB 以下不出现小数，上 GB 保留两位；取不到时显示「未知」 */
export function fmtMem(bytes: number | null) {
  if (bytes === null) return t('未知')
  const mb = bytes / MB
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`
}
