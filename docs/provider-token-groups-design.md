# 供应商内按令牌分组区分模型（Token Groups）设计

## 背景与问题

客户反馈：同一供应商接口会签发多组令牌（分组），不同分组的令牌能拉取/调用的模型不同。

- 「默认分组」令牌可以拉取并调用图片模型；
- 「as 分组」令牌可以调用 sd 模型；
- 换 as 分组令牌后默认图片模型拉取/调用失败。

客户诉求：**同一供应商下**，既要能用 as 分组的 sd 模型，也要能用默认分组的 image 模型。

结论（已确认的实现思路）：模型访问不应只按「供应商」区分，而要在同一供应商内再按「令牌分组」细分——即**按令牌区分模型**。

## 方案概览

在「供应商连接」下新增**令牌分组（token group）**维度：

1. 每个供应商连接除主 API Key（视为「默认令牌」）外，可配置多个命名令牌分组（如「as 分组」），每个分组持有自己的密钥（存 Windows 凭据管理器）。
2. 每个「供应商模型绑定」记录调用该模型使用的令牌分组：
   - `token_group = NULL` → 使用该供应商主 API Key（默认令牌），**向后兼容**；
   - `token_group = 'as分组'` → 使用该供应商下名为 as 分组的令牌。
3. 拉取模型（`/v1/models`）与连通性测试支持选择令牌分组，因为不同分组能拉到的模型目录不同。
4. 生成任务创建时按模型绑定的令牌分组解析对应密钥并冻结到 `api_key_ref_snapshot`。

## 数据模型

新增表 `provider_token_groups`：

```sql
CREATE TABLE IF NOT EXISTS provider_token_groups (
  id TEXT PRIMARY KEY,
  provider_connection_id TEXT NOT NULL REFERENCES provider_connections(id),
  group_name TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(provider_connection_id, group_name)
);
```

`provider_model_bindings` 增加列：

```sql
ALTER TABLE provider_model_bindings ADD COLUMN token_group TEXT; -- NULL = 供应商默认令牌
```

## 后端改动

### 类型（types.rs）

- 新增 `ProviderTokenGroup { id, provider_connection_id, group_name, credential_ref, enabled, created_at, updated_at }`。
- 新增 `UpsertProviderTokenGroupCommand { provider_connection_id, group_name, enabled, secret: Option<String> }`。
- 新增 `DeleteProviderTokenGroupCommand { provider_connection_id, group_name }`。
- `ProviderModelBinding` / `ProviderModelSelection` / `RemoteModelOption` 增加 `token_group: Option<String>`。

### 存储（storage.rs）

- 建表 + 迁移：新增 `provider_token_groups` 表；`provider_model_bindings.token_group` 列（用 PRAGMA table_info 探测缺列即 ALTER）。
- `list_provider_token_groups(provider_connection_id) -> Vec<ProviderTokenGroup>`。
- `get_provider_token_group(provider_connection_id, group_name) -> Option<ProviderTokenGroup>`。
- `upsert_provider_token_group(command) -> ProviderTokenGroup`：存在则更新 enabled；不存在则生成 id + credential_ref 并插入。
- `delete_provider_token_group(provider_connection_id, group_name) -> Option<String>`（返回被删行的 credential_ref，供命令层清理凭据）。
- `provider_token_group_from_row`。
- `binding_from_row` / `replace_provider_model_bindings` 读写 `token_group`。
- 新增 `resolve_binding_credential_ref(provider_connection_id, token_group) -> Result<String>`：`token_group=None` 返回供应商主 api_key_ref；`Some(name)` 查分组 credential_ref，缺失报错。

### Provider 运行时（provider.rs）

- `resolve_current` 保留（主令牌）。
- 新增 `resolve_token_group(provider_connection_id, token_group: Option<&str>) -> ResolvedProviderContext`：`None` 用供应商主 API Key（等价 `resolve_current`），`Some(name)` 按分组解析其密钥。
- 新增 `raw_json_request_with_token_group`：带分组令牌发起 HTTP 请求（测试连通性 / 拉取模型目录共用）。
- `list_models(provider_connection_id, token_group: Option<&str>)`：用对应令牌请求 `/v1/models`，返回模型带 `token_group`（优先取已保存绑定值，否则回显本次拉取分组）。
- `test_connection(provider_connection_id, token_group: Option<&str>)`。

### 任务创建（tasks.rs）与提示词优化（prompt_optimize.rs）

- `tasks::start_inner`：读取模型绑定后，按 `binding.token_group` 解析密钥引用并冻结到 `api_key_ref_snapshot`；`NewTask` 增加 `api_key_ref: &str` 字段。
- `prompt_optimize::optimize_video_prompt`：文本任务同样按绑定分组解析密钥并冻结；任务执行统一走 `resolve_frozen`（api_key_ref_snapshot），无需改动执行路径。

### 命令（commands.rs / lib.rs）

- 新增 `list_provider_token_groups`、`upsert_provider_token_group`（secret 非空则写凭据）、`delete_provider_token_group`（best-effort 删凭据）。
- `fetch_provider_models` 增加可选 `token_group` 参数。
- `test_provider_connection` 增加可选 `token_group` 参数。
- 注册新命令。

## 前端改动

### backend.ts / backendSchemas.ts

- 新增 `ProviderTokenGroup` 类型与 schema。
- `ProviderModelBinding` / `ProviderModelSelection` / `RemoteModelOption` 增加 `tokenGroup`。
- `ProviderSettingsClient` 增加 `listProviderTokenGroups` / `upsertProviderTokenGroup` / `deleteProviderTokenGroup`，`fetchProviderModels` / `testConnection` 增加 tokenGroup 参数。
- `loadSavedProviderModels` 透传 `tokenGroup`。

### ProviderSettingsDialog.tsx / ProviderTokenGroupSettings.tsx

- 新增独立组件 `ProviderTokenGroupSettings.tsx`：「令牌分组」管理区——分组列表（分组名只读、令牌值可回填编辑、保存/测试/删除）、新增分组行；测试连通复用 `client.testConnection(groupName)`；分组密钥只回填到本地、不落库。
- ProviderSettingsDialog 集成：模型列表每行增加「调用令牌」下拉（默认令牌 + 已配置分组），回填该模型保存/拉取时的 tokenGroup。
- 「拉取模型」前增加「拉取令牌」下拉，可选默认令牌或某分组；拉取结果按来源分组标记。
- 保存模型时携带每行的 tokenGroup。

## 验证（已执行，全部通过）

- 后端：`cargo test` 140 个用例全过（137 基线 + 3 新增：分组 CRUD 与凭据解析、绑定持久化 token_group 与删除回退默认、迁移补列且幂等）；`cargo clippy --all-targets -- -D warnings` 无告警；`cargo fmt --check` 通过。
- 前端：`pnpm test` 226 个用例全过（含 backend.ts 契约测试 4 个、ProviderTokenGroupSettings 组件测试 6 个、ProviderSettingsDialog 令牌分组端到端集成测试）；`pnpm typecheck` / `pnpm lint` / `pnpm format:check` 通过；`pnpm build` 生产构建成功。
- 关键语义验证：分组不存在时解析凭据返回 `Conflict` 而非静默回退主令牌；删除分组把引用它的绑定 token_group 置 NULL（回到默认令牌）；同名 upsert 幂等保留原 credential_ref；任务按绑定分组冻结密钥。
