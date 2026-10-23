---
paths: server/comfy.ts, shared/local-image.ts, web/src/components/settings/LocalImageSection.tsx
---

# 本机生图（ComfyUI 安装、启动）

## 装大包先走国内镜像，装不上再回退官方源

- 规则：装 PyTorch 用 `shared/local-image.ts` 的 `torchIndexes()`（开了镜像先用上海交大的 PyTorch wheel 镜像，失败自动回退官方），pip 一律带 `--retries 10 --timeout 60`；装 requirements 时清华索引要挂 `PYPI_FALLBACK` 兜底（清华会缺刚发布的子包）。
- 起因：官方源 1~2 MB/s，2.7GB 的 `torch+cu130` wheel 下到一半断开，安装反复失败（界面上只显示「已取消」）；清华缺 `comfyui-workflow-templates-media-assets-02` 时整条 requirements 装不上。
- 防线：`server/local-image.test.ts` 的 `torchIndexes` 测试。

## CUDA 版本按 ComfyUI 的要求走，不要写死旧版本

- 规则：`TORCH_INDEX.cuda` 用 `cu130`；ComfyUI 0.42 起低于 cu130 会禁掉 comfy-kitchen 的 CUDA 加速后端（启动日志警告 `You need pytorch with cu130 or higher`）。
- 起因：装完 cu128 能 import 也能启动，但量化加速后端被禁，等于装了个慢一半的环境。
- 防线：人工（看启动日志有没有 cu130 警告）。

## 「让 AI 干活」的按钮要真的让它动手

- 规则：需要 AI 直接装、直接改的地方（设置页「让 AI 安装」）用 `FixInput.act = true`，提示词会要求做到底并验证；普通报错和主动体检不带这个字段，仍然只出方案等用户同意。
- 起因：加「让 AI 安装」时复用「AI 处理」通道，默认分支只给方案，装到一半就停在那等用户。
- 防线：`server/fix.test.ts`。
