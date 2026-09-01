# 后端实现与接入说明

## 已实现范围

桌面后端位于 `src-tauri/src/backend/`，由 Tauri 启动时初始化。当前实现覆盖：

- 画布 JSON 的本地持久化和乐观版本控制。
- 多供应商连接、共享模型定义及供应商—模型绑定。
- 从供应商连接的 `Base URL` 请求 `/v1/models`，在设置界面搜索、自动识别能力并精确绑定文生图、图片参考生成或视频生成模型。
- Windows Credential Manager 中的 API Key 安全存储；SQLite 只保存凭据引用。
- Moyu 兼容的文生图、图生图和 Seedance 视频生成适配器。
- 图片、视频、音频素材的稳定引用解析；三种媒体分别从 `1` 开始排序。
- 提示词文字片段和 `@` 精确引用的结构化编译。
- 本地异步任务、无业务并发上限、无取消接口、视频轮询和重启恢复。
- 网络错误和 HTTP `500–599` 的 `2s / 4s / 8s` 指数退避，最多自动重试 3 次。
- 每笔任务、执行尝试、实际非敏感请求、完整原始响应、状态事件和保存结果的 SQLite 持久化。
- 图片和视频结果自动保存到系统解析出的 `<Downloads>/无限画布/`；图片使用本地任务 ID，视频使用远程 `task_id`。
- `.part` 临时写入、媒体魔数校验、SHA-256、原子改名、同名同哈希复用和异内容冲突保护。
- 应用异常退出后把未完成的本地保存标记为 `interrupted`，只恢复文件保存，不重新提交生成。
- 私有 TOS 暂存流程：通过公司预签名服务取得短期 PUT/GET URL，桌面端不持有长期 AK/SK。
- 素材分组、列表、查询、URL 导入、更新和删除的原始透传命令。
- 本地素材目录：SQLite 保存索引，媒体正文只上传对象存储；列表和生成均不调用供应商素材库接口。

SQLite 文件保存在 Tauri 的 `AppLocalData` 目录，文件名为 `infinite-canvas.sqlite3`。数据库启用 WAL、外键约束、`NORMAL` 同步级别和 5 秒忙等待。

## 字符集规范

项目所有文本文件通过 `.editorconfig` 统一为 UTF-8，HTML 入口声明 `charset=UTF-8`。Tauri IPC、Serde JSON、HTTP JSON、Rust 字符串与本地路径均使用 Unicode/UTF-8。

当前数据库是 SQLite，不是 MySQL，所以不存在可以设置的 `utf8mb4` 字符集名称。后端在创建数据库表之前显式设置并读取校验 `PRAGMA encoding='UTF-8'`；SQLite 的 UTF-8 可以完整保存 MySQL `utf8mb4` 所覆盖的中文、CJK 扩展字符和 emoji。真实文件型 SQLite 测试会往返校验中文、`𠮷` 和 `😀`，防止后续修改造成编码回退。

## 第一次配置

后端不内置生产地址、API Key 或未经公司确认的文生图模型 ID。桌面端第一次运行时打开“全局设置 → 供应商连接与模型”，按以下顺序完成配置：

1. 输入供应商显示名称、自定义 `Base URL` 和 API Key，点击“保存连接”。新连接必须填写 Key；已有连接留空 Key 时沿用 Windows Credential Manager 中的凭据。
2. 点击“拉取模型”。界面会先保存当前连接，再由 Rust 后端请求模型列表；保存连接和拉取模型是两个独立动作。
3. 搜索返回的模型，将每个模型互斥分类为“不启用”“图片模型”或“视频模型”。图片模型再选择“文生图”和“图片参考生成”能力；视频模型固定用于视频生成。接口或内置档案已识别的类别会自动预选，已有绑定优先。
4. 点击“保存图片与视频模型”后，图片节点只读取该供应商已启用的图片模型，视频节点只读取视频模型；参数控件直接由对应模型操作 Schema 渲染。
5. 如需使用本地素材库或把本地媒体转为公网 URL，再配置 TOS 对象存储；本地素材上传只写对象存储，不会继续导入供应商素材库。

模型发现使用带 Bearer API Key 的 `GET /v1/models`。`Base URL` 可填写 `https://host`、`https://host/v1` 或包含公司路径前缀的地址；路径拼接会消除重叠的版本段，因此不会生成 `/v1/v1/models`。成功响应兼容以下常见结构：

- OpenAI 兼容的 `{ "data": [{ "id": "..." }] }`。
- `{ "models": [...] }` 或 `{ "data": { "models": [...] } }`。
- 直接返回模型数组，数组项可以是模型 ID 字符串，或包含 `id`、`model_id`、`model` 的对象。

非 `2xx`、无效 JSON 或未知响应结构会作为完整错误返回；错误包含 HTTP 状态、响应头和未改写的原始响应体。模型项可以通过 `operations`、`operation_schema`、`capabilities.operations` 或 `metadata.operations` 提供能力 Schema，也可以用操作数组声明用途。未知且没有可信能力信息的模型不会被猜成全能力，需由用户明确分类。明确设为“不启用”的模型也会保存禁用绑定，后续拉取不会再次自动选中。

拉取模型的本地定义 ID 使用 `remote::{providerConnectionId}::{remoteModelId}` 作用域。同一个远端模型 ID 可以由多个供应商分别保存为不同类别、参数 Schema 和请求字段，互不覆盖。

模型操作 Schema 保存参数类型、默认值、枚举、数值范围、请求路径、参数容器及 `requestField` 映射。任务创建时后端拒绝未知字段与非法值、应用默认值，并冻结规范化参数和操作 Schema；任务重试不会因之后重新拉取模型而改变请求字段。

供应商连接示例：

```ts
const provider = await invoke<ProviderConnection>("upsert_provider_connection", {
  command: {
    id: "company-prod",
    displayName: "公司生产环境",
    adapterId: "moyu_v1",
    baseUrl: "https://由公司确认的地址",
    enabled: true,
  },
});

await invoke("set_credential", {
  command: {
    credentialRef: provider.apiKeyRef,
    secret: apiKeyEnteredByUser,
  },
});
```

## 生成任务命令

`start_generation` 只等待任务快照写入 SQLite，然后立即返回本地任务 ID。远程解析、提交、轮询和保存均在后台继续执行。

```ts
const taskId = await invoke<string>("start_generation", {
  command: {
    canvasId: "canvas-1",
    sourceNodeId: "video-node-1",
    operation: "video_generation",
    providerConnectionId: "company-prod",
    modelDefinitionId: "doubao-seedance-2-0-260128",
    generationCount: 1,
    prompt: [
      { kind: "text", text: "让" },
      {
        kind: "media_reference",
        mentionId: "mention-1",
        displayNameSnapshot: "角色正面",
        target: {
          kind: "asset",
          providerConnectionId: "company-prod",
          assetId: "asset-123",
          mediaType: "image",
        },
      },
      { kind: "text", text: "沿街奔跑" },
    ],
    explicitMedia: [],
    parameters: {
      generate_audio: true,
      resolution: "720p",
      ratio: "adaptive",
      duration: 5,
    },
  },
});
```

查询命令：

- `list_generation_tasks`：轻量分页列表，可按画布、节点和状态过滤。
- `get_generation_task`：完整冻结请求、解析请求、全部尝试、调用、原始响应、事件、结果和最终错误。
- `query_video_task_now`：视频轮询退化后手动重新查询；只查询现有远程任务，不重新提交。
- `list_remote_video_tasks`：以明确的 Unix 秒时间范围读取供应商 `/v1/video/tasks`，避免接口默认只返回服务器当天任务。
- `verify_local_result`：预览前检查本地文件是否存在且哈希一致，更新 `local_missing` 或 `conflict`。

后端会发送以下事件：

- `generation:created`
- `generation:state-changed`
- `generation:retry`
- `generation:retry-exhausted`
- `generation:result-ready`
- `generation:result-saved`
- `staging:state-changed`

生成任务生命周期写入集中在 `GenerationTaskLifecycle::commit`。该 interface 接受 typed lifecycle fact，
在同一个 SQLite transaction 内验证状态图，并提交 attempt、provider call evidence、token、结果、任务投影与事件。
`tasks.rs`、文本生成和本地结果保存路径不再直接调用这些底层写入。SQLite commit 完成后才发送
`generation:state-changed`；终态任务、远程身份和结果保存状态都拒绝被迟到路径覆盖或回退。

错误值直接包含 `kind`、完整消息和 `details`。HTTP 调用的完整响应头与原始响应体保存在任务调用记录；网络运行时错误另外保存运行时消息和回溯。`Authorization`、Cookie、API Key 和预签名 URL 查询串不会进入请求记录。

## 画布持久化命令

- `save_canvas_document`：原子保存完整画布 JSON；`expectedRevision` 用于阻止旧窗口覆盖新版本。首次创建传 `0`，不需要冲突检测时传 `null`。
- `get_canvas_document`
- `list_canvas_documents`

画布删除接口未提供，因为 MVP 明确要求任务历史永久保留，且尚未定义“删除整个项目时是否连带任务”的产品契约。

## TOS 预签名服务契约

桌面端不使用 TOS AK/SK。`configure_tos_staging` 只保存公司预签名服务地址、可选的服务凭据引用和非敏感对象前缀。

桌面端向 `brokerUrl` 发送：

```json
{
  "operation": "create_staging_upload",
  "object_key": "staging/<凭据作用域哈希>/2026/08/21/<uuid>.png",
  "content_type": "image/png",
  "content_length": 12345,
  "purpose": "generation_input"
}
```

预签名服务返回以下对象，允许直接返回或放在 `data` 中，也兼容 camelCase 字段名：

```json
{
  "object_key": "实际对象键，可选",
  "put_url": "短期预签名 PUT URL",
  "get_url": "短期预签名 GET URL",
  "delete_url": "短期预签名 DELETE URL，可选",
  "required_headers": {
    "x-tos-server-side-encryption": "AES256"
  }
}
```

长期 TOS AK/SK 只能保存在公司后端。暂存对象不成为画布素材，也不承担长期预览；生成结果始终以 Downloads 中的本地文件为主副本。

## Tauri 命令清单

### 配置与凭据

- `upsert_provider_connection`
- `list_provider_connections`
- `set_credential`
- `delete_credential`
- `get_credential_status`
- `list_model_definitions`
- `upsert_model_definition`
- `upsert_provider_model_binding`
- `list_provider_model_bindings`
- `fetch_provider_models`
- `replace_provider_model_bindings`

### 画布与生成

- `save_canvas_document`
- `get_canvas_document`
- `list_canvas_documents`
- `start_generation`
- `list_generation_tasks`
- `get_generation_task`
- `recover_generation_tasks`
- `query_video_task_now`
- `list_remote_video_tasks`
- `verify_local_result`

### 素材与暂存

- `list_assets`：只返回规范化的远程素材记录；供应商响应包络、字段别名、状态映射与去重由后端素材库 module 处理。
- `configure_tos_staging`
- `get_tos_staging_config`
- `start_staging_upload`：云端导入目标只提交供应商连接和显示名；分组查找/创建、导入提交、状态轮询与素材 ID 解析由素材库 module 的 `import_staged` interface 统一处理。
- `get_staging_job`
- `list_local_assets`：只查询本机 `local_asset` 索引并为对象存储正文重新签发读取地址，不拉取云端素材库。

### 诊断

- `backend_health`

## 尚需外部提供才能联调的配置

- 公司各环境的真实 `baseUrl`。
- 测试专用 API Key 及允许调用的模型 ID。
- TOS 地域、私有桶、暂存前缀和公司预签名服务地址。
- 预签名服务认证方式；若使用 Bearer Token，可先通过 `set_credential` 写入 `brokerCredentialRef`。

这些值缺失不会影响本地编译、数据库迁移和纯逻辑测试，但无法完成真实供应商与 TOS 契约测试。
