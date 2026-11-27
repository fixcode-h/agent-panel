---
paths: server/file-index/**, server/watch/**, web/src/components/layout/sidebar/FileIndexSidebarStatus.tsx, web/src/components/projects/settings/FileIndexStatusCard.tsx
---

# 文件索引和目录监听

## 通知漏了不要马上整体扫，等安静下来合成一次；跑得久的后台扫描要报进度

- 规则：系统通知溢出（Windows 递归监听没给文件名）、监听出错这类「要整体再扫一遍」的信号，先攒着，安静一段时间且离上次扫描隔开上次耗时的几倍再扫一次（`IndexUnit.verifyLater`）；监听断了扫完要重新盯。几十秒以上的后台扫描（建立、整体核对）都在状态里带 `progress`，界面画百分比，不只转圈。
- 起因：用户 2026-11-27 报侧栏一直「正在核对文件索引」：UE 项目编译、P4 sync 时通知不停溢出，每次溢出马上整体核对引擎根（几十万个目录），核对完下一次溢出又来，进度条又看不出在干什么。
- 防线：`server/file-index/file-index.test.ts`「核对中带进度」；ui-check `07-projects`「文件索引核对」。
