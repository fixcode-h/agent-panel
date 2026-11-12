# DeepSeek 官方 API 选 Anthropic 协议：读取模型报 404

- 状态：已修复（`shared/cli/api-vendors.test.ts`、`server/cli/api-config.test.ts` 通过）
- 症状：API 设置里名称选 DeepSeek、填官方密钥，协议是 Anthropic 时读取模型报「接口返回 404」；同一个密钥查余额正常
- 入口：`server/accounts.ts` 的 `fetchApiModels`、`shared/cli/api-vendors.ts` 的 `apiModelsRequest`
- 根因类型：厂家的 Anthropic 兼容接口只实现了 /v1/messages，没有 /v1/models
- 模块：`shared`（`shared/cli/api-vendors.ts`）
- 关键词：DeepSeek、404、读取模型、Anthropic 协议、/anthropic/v1/models、列模型、官方 API

## 现象

用户用 DeepSeek 官方密钥配置 API，报 404。用同一个密钥实测：`https://api.deepseek.com/user/balance`、`/models`、`/v1/models` 都是 200，
`/anthropic/v1/messages` 能正常回复，只有 `/anthropic/v1/models?limit=1000` 回 404。

## 根因

`fetchApiModels` 对 Anthropic 协议一律拼 `<地址>/v1/models`，DeepSeek 的 Anthropic 兼容接口（`https://api.deepseek.com/anthropic`）没有这个路径。密钥和地址本身没问题。

## 修复

- 厂家定义 `ApiVendor` 加可选的 `models.url`（OpenAI 风格、Bearer 认证），DeepSeek 填 `https://api.deepseek.com/models`。
- 用的是厂家默认地址时，列模型走这个接口；用户自己填了地址（中转站）照旧按用户的地址列。
