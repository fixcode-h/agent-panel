---
paths: web/src/components/ui/modal.tsx, web/src/components/tasks/DiffDialog.tsx, web/src/components/tasks/TaskFiles.tsx, web/src/components/tasks/TurnChanges.tsx, web/src/components/tasks/ChangesTree.tsx
---

# 差异窗口的尺寸和文件树

## 差异窗口用 diff 档：宽度接近铺满，高度跟内容走

- 规则：差异窗口（`DiffDialog` / `TurnDiffDialog` / `ProjectDiffDialog`）用 `Modal` 的 `size="diff"`，不套 `xl` 的最小高 640：外层没有固定高度，短 diff 按内容收紧，长 diff 到视口上限后由正文自己滚动，左右对照也能拿到接近整屏的宽度。单次工具编辑的差异（`own`）用 `fit`（1100 宽、最高到视口），不要也给 `diff`——通常就几行，太宽反而空。
- 规则：一轮改动的左栏文件树在 `lg` 以下自动隐藏，`lg` 以上用 `DiffShell` 的 `sidebar` 按钮收起 / 展开；不要给差异窗口加固定最小高度，也不要把文件树固定成 `md:flex`（820px 时会把对照两栏各挤掉一半）。
- 起因：用户 2026-11-02 反馈「差异弹窗太小了…弹窗大小和对应的内容不匹配」：13 个文件的差异窗口只有 1100 宽、最小高 640，左右两栏频繁换行，短 diff 又留一大块空白。
- 防线：`scripts/ui/02c-element-pick.mjs` 的「差异-一轮改动-长 / 短 / 窄屏」断言窗口高、宽和文件树显隐；`node scripts/ui-check.mjs 02c`。
