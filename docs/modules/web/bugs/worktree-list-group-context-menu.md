# 环境弹窗的「独立分支」没分类、也没有右键菜单

- 状态：已修复（写文档时本轮重跑 `npx tsx --test web/src/lib/worktrees.test.ts` 6 条全过、`npx prettier --check` 和 `node scripts/rules-check.mjs` 通过；代码改动那边已跑过 `node scripts/ui-check.mjs 02` 并通过，含新增的「独立分支-右键菜单」「独立分支-右键删除确认」）
- 模块：`web`（`web/src/components/tasks/Worktrees.tsx` 的 `WorktreeSection` / `WorktreeRow`，分组口径在 `web/src/lib/worktrees.ts`），配套 `scripts/ui/02-task.mjs`
- 关键词：独立分支、worktree、已删除 / 未删除、分组、右键菜单、ContextMenu、合并、删除独立分支、行内按钮、`data-worktree-group`

## 现象

环境弹窗的「独立分支」一节里，标题右边写着「4 个没合并」，下面把当前对话和名下子对话的分支混在一起平铺：状态图标（⚠ 未合并 / ✓ 已合并）、`dev → agent-panel/c9acb42c`、第二行「修复复制粘贴丢失卡片与截断 · 正在执行，不改动原目录」。分支还在的和已经删掉的（合并掉或直接删掉的）排在同一列里，只能靠图标和删除线分辨；操作只有鼠标悬停到行尾才出现的「合并」「删除」两个小图标，没有右键菜单。用户报的是「worktree 已删除和没有删除的做个分类展示，然后每个项增加右键菜单，支持合并和删除等操作」。

## 根因

- `WorktreeSection` 直接 `orderWorktrees(items).map(...)` 平铺全部项，`orderWorktrees` 只负责「父对话第一、其余按创建时间」，不看 `item.state`，所以 `active`（分支还在）、`merged`（已合并、分支已删）、`discarded`（已删除、改动没合并）三种状态的行依次混排。
- `WorktreeRow` 行上只有 `idle`（`active && !item.working`）时才显示的两个行内按钮，没有 `ContextMenu`，也没有别的入口。
- 后端不是原因：`GET /tasks/:id/worktrees`（`server/tasks.ts`）用 `[tk, ...kids].filter((x) => x.worktree)` 取列表、不看工作目录是否 `exists`；`POST /tasks/:id/worktree/discard` 只 `removeWorktree` 删目录和分支，再把 `task.worktree` 改成 `{ ...wt, state: 'merged' | 'discarded', note }`，task 上的记录一直留着。所以「已删除」的项前端本来就拿得到，缺的只是分组展示，这次没有改后端。

## 修复

- `web/src/lib/worktrees.ts` 新增纯函数 `groupWorktrees(items)`，返回 `{ live, removed }`：`live` 是 `state === 'active'`，`removed` 是其余（`'merged'` / `'discarded'`）；两个桶各自再走 `orderWorktrees`，所以组内顺序不变、父对话在自己那组的第一位。
- `WorktreeSection` 用 `groupWorktrees` 渲染两组，每组一个带数量的标题（「未删除」/「已删除」，分别标 `data-worktree-group="live"` / `"removed"`），空组不渲染；顶部「{n} 个没合并」的警告保留（`unmergedOf` 的口径没变）。
- `WorktreeRow` 外层包 `ContextMenu` / `ContextMenuTrigger`（`web/src/components/ui/menu.tsx`，写法和 `web/src/components/layout/SidebarTasks.tsx` 一致），菜单项：打开对话、合并到原分支、用 AI 合并、复制分支名、复制路径、删除独立分支（`danger`）。合并 / 删除 / 打开都复用现有回调（`useWorktreeActions` 的 `merge`、`askRemove` 弹确认框，`onOpenChild`，模块已有的 `aiMerge`），菜单里不另写合并删除逻辑；行内悬停出现的「合并」「删除」按钮保留，右键是补充入口。
- 新增 `mergeState(item, busy)` / `removeState(item, busy)` 两个纯函数返回 `{ ok: true } | { ok: false, reason }`，行内按钮和菜单项共用这一套判定：非 `active` → 「这个分支已经删除了」（后端 `discard` 的 `isolated` 只认 `active`，已删除的项点了必被拒，所以不能给可点；行内按钮本来就按 `idle` 隐藏，两边口径因此一致），`busy` → 「正在处理这个独立分支，等它结束」，`working` → 「对话正在执行，等这一轮结束后再合并 / 再删除独立分支」，`needsMerge` 为假 → 「这个分支没有要合回原分支的改动」；当前对话自己那行没有 `onOpen`，「打开对话」不可用并把原因（「这是当前对话自己的分支」）写进 `title`。不适用的菜单项**不用真 `disabled`**：`menuItem` 类里的 `data-[disabled]:pointer-events-none` 会让鼠标悬不上去、原生 `title` 根本弹不出来，改用组件内的 `Unavailable`（`aria-disabled` + `cursor-not-allowed opacity-50` + 保留指针事件），鼠标能悬住看到原因，点了也把原因 `toast.error` 出来。
- 文案走 `t('中文原文')`，英文同提交写进 `shared/locales/en/tasks.ts`（`node scripts/i18n-check.mjs` 报文案 4405 条、英文 4405 条）；复制用组件内的 `copyText`，失败 toast「复制失败」。

## 防线

- `web/src/lib/worktrees.test.ts` 的 `groupWorktrees` 三条用例：「按删除与否分两组：active 归未删除，merged / discarded 归已删除」「分组后组内仍走创建时间升序，父对话在它那组的第一位」「没有已删除项时那一组是空数组，不改动入参」。分组口径写错、或者分组时顺手把组内顺序丢掉（例如排序挪到分组之前只做一次）都会被拦住。
- `scripts/ui/02-task.mjs` 的独立分支用例改成按组取行（`rowsIn(group)`，定位 `[data-worktree-group="live"]` / `"removed"`），断言两组各几行、未删除组第一行是父对话自己、组内按创建时间升序、已删除组里有已合并那条——混排或者把某一组过滤掉都会失败。
- 「独立分支-右键菜单」：右键弹菜单、6 个菜单项都在、正在执行的那项「合并到原分支」「删除独立分支」是 `aria-disabled`、`pointer-events` 不是 `none`、`title` 写了原因（真 `disabled` 会被 `pointer-events-none` 当成悬不上，这条断言就是拦它）。
- 「独立分支-已删除不可操作」：已删除组（`data-worktree-group="removed"`）里的合并 / 删除同样不可用，点一下会 `toast`「这个分支已经删除了」——拦截「菜单能点、点了后端报错」这种两边口径不一致。
- 「独立分支-右键删除确认」：从右键菜单点「删除独立分支」弹出确认框（文案含分支名），且不连带打开对话面板。菜单项的 `onSelect` 只该走 `askRemove`：如果顺手调了 `onOpen`，或者把删除按钮也接在行上可点的位置，右栏就会被连带打开，这条断言拦住这种情况。
