# 模型目录

三档模型的上下文窗口、最大输出和思考强度不再按 CLI 写死在配置里，而是按模型名查模型目录。
目录分两份，合并后使用：

- 内置目录：[`shared/model-catalog.json`](../shared/model-catalog.json)，跟着面板一起发布
- 用户补充目录：数据目录的 `config/models.json`（默认 `~/.agent-panel/config/models.json`），
  设置 → CLI → 模型目录里点「AI 补全」时由 AI 查完写进来；同厂商同 `id` 的记录覆盖内置的

## 一条记录

```json
{
  "vendor": "deepseek",
  "id": "deepseek-v4-flash",
  "label": "DeepSeek V4 Flash",
  "type": "flash",
  "version": "4",
  "protocols": ["openai-chat", "openai-responses"],
  "context": 1000000,
  "maxOutput": 128000,
  "efforts": ["low", "high", "max"],
  "defaultEffort": "high",
  "tier": "low",
  "aliases": [],
  "source": "https://api-docs.deepseek.com/"
}
```

| 字段            | 说明                                                                      |
| --------------- | ------------------------------------------------------------------------- |
| `vendor`        | 厂商：`anthropic`、`openai`、`google`、`deepseek`、`moonshot`、`zhipu`……  |
| `id`            | 模型 id，不带 `provider/` 前缀                                            |
| `label`         | 显示名                                                                    |
| `type`          | 模型类型：`flash`、`pro`、`max`、`plus`、`opus`、`reasoning`、`general`…… |
| `version`       | 版本：`4`、`5.5`、`k3`；没有版本时留空                                    |
| `protocols`     | 支持的协议：`anthropic`、`openai-responses`、`openai-chat`、`gemini`      |
| `context`       | 上下文窗口（token）                                                       |
| `maxOutput`     | 最大输出（token）                                                         |
| `efforts`       | 可选的思考强度，取值和 CLI 的 efforts 一致；模型不支持思考时是空数组      |
| `defaultEffort` | 这个模型默认的思考强度                                                    |
| `tier`          | 模型等级：`high` 旗舰、`medium` 日常、`low` 快速便宜                      |
| `aliases`       | 其他也能匹配到这条记录的写法                                              |
| `source`        | 信息来源（官方文档地址）；AI 补全时会写                                   |

## 匹配规则

用户粘贴的模型名经常带网关、provider、协议和速度后缀，例如：

```
tokenapi/deepseek/deepseek-v4-flash
deepseek/deepseek-v4-flash-responses
deepseek-v4-flash-fast
```

按下面的顺序匹配：

1. **只取最后一段**，去掉 `tokenapi/deepseek/` 这类前缀。
2. **去掉协议后缀**：`-responses` → OpenAI Responses，`-chat` / `-completions` → OpenAI Chat，
   `-anthropic` / `-messages` → Anthropic，`-gemini` → Gemini。
3. **去掉速度、预览后缀**：`-fast`、`-turbo`、`-speed`、`-preview`、`-beta`、日期等不参与匹配。
4. **厂商初筛**：用 `-` 分开后的第一个词判断厂商（`deepseek`、`claude`、`gpt`、`qwen`、`glm`、`kimi`……），
   也可以看 `provider/` 前缀（`moonshotai/`、`zai-org/`）。目录里没有这个厂商的模型就不匹配。
5. **模型类型的优先级高于版本**。目录里只有 `deepseek-flash` 和 `deepseek-v4-pro` 时：
   - `deepseek-v4-flash` → `deepseek-flash`（`flash` 是模型类型）
   - `deepseek-v4-pro` → `deepseek-v4-pro`
   - `deepseek-v4-flash` 不会因为版本同为 `4` 而匹配 `pro`
6. **当前 API 的协议优先**：同分时，选支持当前协议（Responses / Chat / Anthropic / Gemini）的记录。
   模型名自带 `-responses` 这类后缀时按后缀算。

匹配分数太低（例如只是名字里碰巧有某个词）时当作没找到。**没找到的模型统一按 1M 上下文、128K 最大输出估算**，
思考强度交给 CLI 自己决定。

## 补充目录和 AI 补全

设置 → CLI → 模型目录：

- 开关「未知模型用 AI 补全」打开后，三档模型里目录没有的模型旁边会出现「AI 补全」。
- 点击后按「AI 创建」里设置的 CLI 跑一次只读查询，让它用联网搜索查官方文档，
  输出上面的 JSON；面板校验后写进 `~/.agent-panel/config/models.json`。
- 写进去的记录会立即参与匹配，三档模型的自动值也会重新计算。
- 想手工维护时直接编辑这个 JSON 即可，格式和内置目录一样。
