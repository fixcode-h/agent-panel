# ADR 0029：本机语音输入用 sherpa-onnx，识别库和模型都按需下载到数据目录

状态：已接受 · 2026-10-29

## 背景

用户要求把本机语音识别接进对话输入框，并要求：默认不下载模型，在设置里打开「语音输入」后输入框才显示麦克风按钮；模型版本由用户自己选择下载。
要定的是三件事：用哪个识别引擎、原生识别库怎么交到用户手上、录音怎么从浏览器送到服务端。

## 事实核对

| 位置                                   | 现状                                                                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/package.mjs`                  | 服务端用 esbuild 打成单文件 `server.mjs`，依赖全部内联；包里没有 `node_modules`，解压后只要 Node.js 20+                                                                  |
| `server/download.ts` 的 `downloadFile` | 大文件分片并发、断点续传、可取消，本机生图下模型就用它                                                                                                                   |
| `server/update.ts`                     | 在线更新用系统自带的 `tar` 解压（Windows 10 起自带）                                                                                                                     |
| `server/index.ts` 的全局中间件         | 写操作必须是 `application/json`，挡跨站的 text/plain POST                                                                                                                |
| npm `sherpa-onnx-node`（1.13.8）       | 原生扩展；平台库在兄弟包 `sherpa-onnx-<平台>-<架构>` 里，`addon.js` 按 `../sherpa-onnx-<平台>/` 找；有 `OfflineRecognizer.createAsync` / `decodeAsync`（不阻塞事件循环） |

## 决策

1. **引擎用 sherpa-onnx**：一套接口同时跑 SenseVoice、Paraformer、Whisper，有官方 Node 原生扩展，不用 Python（项目约定全部 TypeScript）。
   - 放弃：whisper.cpp（只能跑 Whisper，中文和中英混说不如 SenseVoice，还要为每个平台另备可执行文件）；浏览器里跑 transformers.js（每个浏览器各下一份几百 MB 的模型，CPU 上慢）；FunASR（要 Python）。
2. **识别库按需下载，不打进包里**：原生扩展打不进单文件的 `server.mjs`。第一次下载模型时，从 npm 取 `sherpa-onnx-node` 和本机平台的 tgz，用系统 `tar` 解到 `<数据目录>/speech/sherpa-onnx-<版本>/node_modules/`，用 `createRequire` 加载。版本固定在 `shared/speech.ts` 的 `SHERPA_VERSION`。
   - 放弃：把各平台的原生库都放进发布包。包会大几十到上百 MB，而大多数人不用语音输入。
3. **模型由用户挑**：`shared/speech.ts` 的 `SPEECH_MODELS` 列出可选模型（SenseVoice int8 / 完整精度、Paraformer 中文 Small、Whisper Small / Turbo），每个都能单独下载、删除，`Settings.speech.model` 记用哪个。默认一个都不下载。
4. **录音在浏览器转成 16kHz 16 位 PCM、base64 放进 JSON 上传**：AudioWorklet 收原始采样，停下时重采样、编码。不用 MediaRecorder（只出 webm / ogg，服务端还得解码）；不发二进制体（全局中间件只放行 JSON 写请求）。

## 操作清单 / 契约

| 项                                                                                                 | 内容                                                                                                        |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 设置 `Settings.speech`                                                                             | `enabled`（默认 false，关着时不显示按钮）、`model`（不认识的值回退默认）、`mirror`（hf-mirror / npmmirror） |
| `GET /api/speech/status`                                                                           | `SpeechStatus`：平台有没有预编译包、识别库在不在、已下载的模型、下载进度                                    |
| `POST /api/speech/models/:id/download`、`DELETE /api/speech/models/:id`、`POST /api/speech/cancel` | 同一时间只有一个下载；正在下载的模型不能删                                                                  |
| `POST /api/speech/transcribe`                                                                      | `{ audio: base64 }` → `{ text }`；最长两分钟；没打开、没下载、加载失败都返回 400 和原因                     |
| 数据目录                                                                                           | `speech/sherpa-onnx-<版本>/node_modules/…`、`speech/models/<模型 id>/…`                                     |

## 与现有实现的关系

- 服务端 `server/speech.ts`（路由挂在 `server/index.ts`），下载复用 `server/download.ts`，解压和在线更新同一办法。
- 前端：`web/src/lib/speech-recorder.ts` 录音，`web/src/components/chat/SpeechButton.tsx` 挂在 `ChatComposer` 的工具条上（所有对话输入框共用），设置页 `web/src/components/settings/SpeechSection.tsx`。
- 演示版在 `web/src/lib/demo-backend.ts` 的 `demoSpeech` 回固定文字。

## 运行时

识别器按当前模型懒加载、只留一个，换模型时丢掉旧的；识别排队一个一个来。识别失败、麦克风没权限都弹提示说明原因，不重试。

## 分期

一次做完：点按录音、松开识别。边说边出字（流式 Paraformer / Zipformer）以后需要时另加。

## 风险与代价

- 原生库的加载问题（缺系统运行库、macOS 的动态库路径）只能在用户机器上暴露：加载失败把识别库的原始报错显示出来。
- 模型文件名靠 sherpa-onnx 的发布包核对，Hugging Face 上改名会 404：下载失败原样报给用户。
- 浏览器只在 localhost / https 允许麦克风：用外网访问的 http 地址打开时按钮会报这条原因。

## 开放问题

- 要不要加快捷键（按住说话）：倾向加在「快捷键」设置里，先只做点按。
