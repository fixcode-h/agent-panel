/**
 * 保存项目前的乐观锁：客户端带上读取时的 `updatedAt`，服务端刚读到的不一致就说明期间被别处改过。
 *
 * 为什么需要：`PUT /projects/:id` 是整份覆盖，而报告面板和设置页手里的项目是打开时读的旧快照；
 * 初始化对话、别处应用推荐都会在这期间写项目，整份 PUT 会把它们写回旧值
 * （见 docs/modules/web/bugs/init-apply-overwritten-by-snapshot.md 的「GET → 整份 PUT 的竞态」）。
 * 没带 `expectedUpdatedAt` 的请求（脚本、旧界面）保持原来的整份覆盖行为。
 */
export function staleProjectWrite(currentUpdatedAt: string | undefined, expected: string | undefined): boolean {
  // 没带版本（脚本、旧界面）或项目已经不在了（交给 update 返回 404）都不算冲突
  if (expected === undefined || !currentUpdatedAt) return false
  // 空串也是「我读到的版本」：服务端已经有值就说明读到的数据是旧的，不能退化成无锁
  return currentUpdatedAt !== expected
}
