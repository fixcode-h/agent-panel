# 截帧弹窗点播放报「The play() request was interrupted by a call to pause()」

- 状态：已修复（`npx tsx --test shared/attachment-view.test.ts shared/video.test.ts server/video/frames.test.ts` 通过；本机起面板用 Playwright 实测：点播放后马上点画面暂停不再弹错，1080p60 视频能正常播放）
- 症状：截帧弹窗里视频「播放不了」，右上角弹出英文报错 `The play() request was interrupted by a call to pause()`；同一批反馈：视频区域太小、「处理选中的帧」点了没反应、自动截帧和增强没有进度
- 入口：`web/src/components/video/VideoFramesDialog.tsx` 的 `togglePlay`
- 根因类型：把浏览器的 AbortError 当成播放失败弹给用户；按钮在缓冲时没有反馈
- 模块：`web`（`web/src/components/video/`），配套 `server/video/frames.ts` 的自动截帧进度
- 关键词：视频、截帧、play()、pause()、AbortError、缓冲、自动截帧进度、增强进度、视频卡片、帧图片

## 根因

- `HTMLMediaElement.play()` 返回的 Promise 要等缓冲够了才兑现；期间任何一次 `pause()`（再点一下播放键 / 画面、按空格、点帧条或时间轴上的帧、帧播放）都会让它以 `AbortError` 拒绝，消息就是这句英文。
- `togglePlay` 写的是 `v.play().catch((e) => toast.error(e.message))`，把这个「用户自己要的暂停」当成错误弹了出来。大视频（1080p60 录屏）缓冲久，按钮却立刻变成「暂停」、画面不动，看起来就是放不了，用户再点一下就触发了这条报错。
- 「处理选中的帧」在没有帧时是禁用的，但旁边没写原因，看起来像点了没反应。

## 修复

- `togglePlay`：`AbortError` 不提示；`NotSupportedError`（浏览器解不了的编码）改用 FFmpeg 取画面预览；停在结尾时从头放。缓冲中（`waiting` 到 `playing`）播放键转圈。
- 视频不再一放进来就弹窗：作为卡片留在输入框（只引用原路径），点卡片打开截帧弹窗，选好的帧记在卡片上，发送时由 `withVideoFrames` 把视频卡片原位换成帧图片卡片、`sendAttachments` 换成帧图片附件；没选帧时发送会先打开弹窗。
- 弹窗改成 `size="full"`，画面区 `flex-1` 占满剩下的高度；自动截帧按服务端 `/video/frames/progress` 显示「分析画面 n% / 截取第 i/n 张」，增强一张张做、正在处理的帧上盖转圈、排队的标「等待」，都能停止；帧双击全屏看大图，`Lightbox` 加了滚轮缩放、拖动、双击放大 / 还原（`web/src/components/ui/zoom-image.tsx`）。

## 防线

- `shared/attachment-view.test.ts` 的视频卡片用例：没选帧不发、选了帧后附件和文字都换成帧、交给 Agent 的文字里没有视频路径。
- `shared/video.test.ts` 的 `ffmpegTime` 用例：进度从 ffmpeg 状态行解析，`time=N/A` 时不算。
