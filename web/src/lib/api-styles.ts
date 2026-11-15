/** 风格库和浏览器扩展的接口：从 api.ts 拆出（api.ts 到了行数上限），api 里展开引入，调用方照旧用 api.xxx。
 *  按 shared/api-contract/styles.ts 的契约调。UI 设计本身的接口在 UI 设计插件里；
 *  浏览器扩展的地址还是以前挂在设计接口下的 /designs/browser，扩展和旧版本认这个地址 */
import type { SavedStyleInput } from '@shared/style-types'
import { browserExtContract as B, stylesContract as S } from '@shared/api-contract/styles'
import type { BodyOf } from '@shared/api-contract/define'
import { call } from './api/call'

export const stylesApi = {
  browserStatus: () => call(B.status),
  styles: () => call(S.list),
  // 调用方传的是编辑时的样子（z.input，kind 这些可以不填）；契约的请求体类型按 parse 之后算，默认值由服务端补
  createStyle: (input: SavedStyleInput) => call(S.create, { body: input as BodyOf<typeof S.create> }),
  updateStyle: (id: string, patch: Partial<SavedStyleInput>) => call(S.update, { params: { id }, body: patch }),
  deleteStyle: (id: string) => call(S.remove, { params: { id } }),
  installExtension: (browser: string) => call(B.install, { body: { browser } }),
  reloadExtension: (browser: string) => call(B.reload, { body: { browser } }),
  revealExtension: () => call(B.reveal, { body: {} }),
}
