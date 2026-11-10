/** 英文词典的一部分，键是中文原文：几个对话共用一个目录时的提醒和改动卡片上的说明（shared/shared-dir.ts、server/turn-owners.ts） */
export const EN_SHARED_DIR: Record<string, string> = {
  '「{title}」正在这个目录里改文件，两边的改动可能互相影响':
    '"{title}" is editing files in this directory; the two conversations\' changes may affect each other',
  '「{title}」等 {n} 个对话正在这个目录里改文件，两边的改动可能互相影响':
    '"{title}" and {n} conversations in total are editing files in this directory; their changes may affect this one',
  未命名对话: 'Untitled conversation',
  这个对话开独立分支: 'Move this conversation to its own branch',
  不再提示: "Don't show again",
  '这个项目里不再出现这条提醒（记在这个浏览器里）': 'Hide this notice for this project (remembered in this browser)',
  '对话正在执行，等这一轮结束后再开独立分支':
    'The conversation is running. Wait for this turn to finish before creating a branch',
  '从项目最新的提交开一个单独的分支和目录，这个对话之后在里面改，做完再合并或丢弃':
    "Create a separate branch and directory from the project's latest commit. This conversation works there from now on; merge or discard it when done",
  '已开独立分支 {name}，下一句起在里面做；这个对话之前没提交的改动留在原目录':
    "Created branch {name}. The next message runs there; this conversation's earlier uncommitted changes stay in the original directory",
  只有项目里的顶层对话可以自己开独立分支: 'Only a top-level conversation in a project can create its own branch',
  这个对话已经在独立分支里了: 'This conversation is already on its own branch',
  '开独立分支失败：{error}': 'Failed to create the branch: {error}',
  '另有 {n} 个文件是同目录里别的对话改的，没有算进来，撤销时也不会动':
    '{n} more file(s) were changed by other conversations in this directory. They are not counted here and undo leaves them alone',
}
