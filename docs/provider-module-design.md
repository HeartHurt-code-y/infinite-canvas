# 统一供应商模块设计

状态：MVP 设计 v0.7

## 目标

让使用相同请求与响应协议的多个供应商共用一套生成实现。新增这类供应商时，只增加一条供应商连接和模型绑定，不复制生成节点、请求构造器、轮询逻辑或错误处理。

这项设计把四件事分开：

```text
供应商连接 ──┐
             ├─> 解析后的执行上下文 ─> 协议 Adapter ─> 远程供应商
模型定义 ────┤
             │
节点任务快照 ┘
```

- **供应商连接**决定请求发往哪里、使用哪一份凭据以及选择哪个 Adapter。
- **模型定义**决定节点有哪些输入、参数和结果类型。
- **供应商模型绑定**决定某个供应商连接实际开放哪些模型。
- **协议 Adapter**决定如何构造端点、请求体、multipart、轮询和成功结果。

## 配置模型

### 供应商连接

```ts
type ProviderConnection = {
  id: string;
  displayName: string;
  adapterId: string;
  baseUrl: string;
  apiKeyRef: string;
  enabled: boolean;
};
```

- `id` 是稳定身份；修改显示名称或地址不能产生一个新身份。
- `displayName` 只用于界面显示，不参与请求分支。
- `adapterId` 标识请求与响应协议族。MVP 的五份公司接口属于同一个 Moyu 兼容协议族；生成模块和素材库模块分别提供小 Interface，并复用同一条供应商连接配置。
- `baseUrl` 是供应商连接的请求根地址。路径拼接、斜杠处理和端点选择由 Adapter Implementation 完成。
- `apiKeyRef` 指向 Tauri 后端安全保存的凭据，不是 API Key 明文。
- `enabled=false` 时不能发起新任务，但历史任务仍保留原供应商快照以便解释和恢复。

### 模型定义

```ts
type GenerationOperation = "text_to_image" | "image_to_image" | "video_generation";

type ModelDefinition = {
  id: string;
  displayName: string;
  remoteModelId: string;
  operations: Partial<
    Record<
      GenerationOperation,
      {
        resultType: "image" | "video";
        requestProfileId: string;
        profileVersion: number;
        request: {
          path: string;
          encoding: "json" | "multipart";
          parameterContainer: "root" | "metadata" | "multipart";
        };
        parameters: Record<
          string,
          {
            type: "string" | "integer" | "number" | "boolean";
            default?: string | number | boolean;
            enum?: Array<string | number | boolean>;
            minimum?: number;
            maximum?: number;
            requestField?: string;
            requestLocation?: "root" | "metadata" | "multipart";
          }
        >;
      }
    >
  >;
};
```

内置模型档案可以跨供应商作为发现阶段的能力模板；用户从真实接口拉取并保存的模型定义使用供应商作用域 ID。一个保存模型只能归为图片或视频一种类别：图片类别可以开放文生图、图片参考生成或两者，视频类别只开放视频生成。供应商名称、地址和密钥不能进入模型定义。

模型目录响应如果在 `operations`、`operation_schema`、`capabilities.operations` 或 `metadata.operations` 中提供操作 Schema，后端会保留并验证它；`supported_operations` 等操作数组也会用于自动预选。内置已知模型使用版本化档案补齐 Schema。目录没有可信能力信息时，后端按已知图片、视频和文本模型家族的命名约定保守预选一个类别，媒体家族优先于同厂商的文本品牌规则；仍无法识别的模型保持未启用，必须由用户明确分类。设置界面对首次拉取且尚未配置的图片模型默认同时开启图片参考生成；用户可以手动关闭，重新拉取已保存模型时继续采用已有配置。

参数名称是节点和任务使用的规范名称。`requestField` 与 `requestLocation` 负责映射供应商实际字段及所在容器，因此模型可以把 `frames` 映射为 `metadata.frame_count`，而不在节点或请求构造器中增加模型名称分支。Schema 声明的新字符串、数值、布尔或枚举参数会直接出现在对应生成节点卡片中。

如果同名模型在两个供应商处的参数或行为并不兼容，它们不是同一个模型定义：应建立不同版本的模型定义，或者让供应商选择不同 Adapter，不能在一个模型定义内部写供应商判断。

### 供应商模型绑定

```ts
type ProviderModelBinding = {
  providerConnectionId: string;
  modelDefinitionId: string;
  enabledOperations: GenerationOperation[];
  remoteModelId?: string;
  enabled: boolean;
};
```

- 保存成功的绑定必须包含该供应商返回的真实 `remoteModelId`；任务不会回退到全局模型 ID。
- `enabledOperations` 只允许图片操作集合或视频操作集合，后端拒绝把两类操作混存在同一绑定。
- 禁用绑定使用空 `enabledOperations`，用于记住用户明确选择的“不启用”。
- 绑定不重复保存端口或参数定义。
- 同一个远端模型 ID 可以出现在任意多个供应商连接中，每个供应商使用独立的作用域模型定义。

## 对外 Interface

画布不直接调用具体供应商端点。Task Module 在后台通过以下内部 seam 调用供应商模块：

```ts
interface GenerationProvider {
  submit(command: ResolvedGenerationCommand): Promise<GenerationSubmission>;
  observe(task: RemoteGenerationTask): Promise<GenerationObservation>;
}

function createGenerationProvider(
  connection: ResolvedProviderConnection,
  dependencies: ProviderDependencies,
): GenerationProvider;
```

`createGenerationProvider` 是统一的供应商创建函数。同一个 `adapterId` 永远返回同一类 Adapter Implementation，只注入不同的 `baseUrl` 和运行时解析出的 API Key。节点调用方不需要知道文生图、multipart 图片编辑或视频轮询使用了哪个 HTTP 端点。

`ResolvedGenerationCommand` 由 Task Module 的媒体引用模块产生，包含冻结的结构化提示、渲染后的实际提示字符串，以及已经解析的 `images[]`、`videos[]`、`audios[]`。每项都携带媒体类型、同类型内从 `1` 开始的 `typePosition`、角色、MIME、字节数和内容哈希。Provider Adapter 不接收编辑器 DOM、`@显示名称` 或待解析素材 ID，也不负责搜索素材库。

同步图片请求通过 `submit` 直接得到图片结果；异步视频请求通过 `submit` 得到远程任务引用，再由 `observe` 查询。图片和视频的本地文件保存都是独立阶段，不塞进这个生成 Interface。

画布调用的是 [异步生成 Task Module](./generation-task-design.md)，它先持久化本地任务并立即返回任务 ID，再在后台调用这里的 `submit`。因此供应商端点是否同步，不决定画布是否阻塞；同一节点的多个 Task Module 执行可以同时调用同一个无状态 Provider Adapter。

Provider Adapter 的每次 `submit` 或 `observe` 调用只执行一次真实 HTTP 尝试，不在 Adapter 内部静默重试。网络错误与 HTTP `500–599` 的最多 3 次指数退避由 Task Module 统一编排，确保每次尝试的原始错误和提醒都能独立保存。

所有 Adapter 的 HTTP 调用必须经过同一条内部调用捕获路径，不能各自直接创建无法观测的 HTTP 客户端。这条路径在发送前把 Adapter 已经映射完成的非敏感实际请求写入任务调用记录，收到结果后追加完整原始返回或运行时异常。调用捕获隐藏在供应商模块 Implementation 内，不扩大画布使用的 `GenerationProvider` Interface。

请求记录排除 `Authorization`、API Key、Cookie、TOS 签名查询串和临时签名 URL；结构化提示保存引用出现位置与稳定身份，每个媒体输入保存 `mediaType + typePosition`，multipart 文件还保存对应字段名、文件名、MIME、字节数和内容哈希，不重复复制媒体字节。安全排除不作用于供应商返回：无论成功或失败，状态、响应头和原始响应体都完整交给 Task Module 持久化。

## 提交流程

1. 生成节点冻结包含操作类型、供应商连接 ID、模型定义 ID、参数、结构化提示、`@` 引用和显式媒体输入的任务快照。后端按模型 Schema 拒绝未知字段与错误类型，应用默认值、枚举和范围约束，并同时冻结本次操作的 `requestProfileId`、`profileVersion` 与完整操作 Schema。
2. Task Module 的媒体引用模块按稳定身份解析公司素材或本地生成结果，分别形成冻结的 `images[]`、`videos[]`、`audios[]`，为每项写入同类型位置、角色和内容哈希，并生成实际提示字符串；不兼容或不可读取时在调用供应商前保存完整本地错误并停止。
3. 供应商模块读取供应商连接和供应商模型绑定。
4. 后端通过 `apiKeyRef` 读取 API Key；明文只存在于本次后端请求所需的内存中。
5. 模块形成解析后的执行上下文：Adapter ID、`baseUrl`、凭据引用、实际远程模型 ID 和操作类型。
6. Adapter 根据冻结的操作契约构造真实端点、字段名、参数容器和请求格式；统一调用捕获路径先持久化实际非敏感请求，再注入仅存在于内存中的凭据并发送请求。
7. HTTP 成功或失败响应先以原始形式追加到调用记录，再由 Adapter 解释为同步媒体结果、异步任务引用、观察结果或失败。
8. 运行时异常连同类型、消息、堆栈和 cause 链追加到调用记录，不生成替代错误消息。
9. Task Module 只有在返回记录和任务状态都持久化后才向查询 Interface 暴露新的终态。

提交后，任务记录冻结实际使用的 Adapter ID、`baseUrl`、凭据引用、远程模型 ID、规范化参数和模型操作 Schema。用户随后修改模型参数能力、禁用或删除供应商连接，都不能改变已提交任务的请求字段或默认值。删除连接时应保留任务所需的最小历史快照；是否仍能查询远程任务取决于原凭据是否可用。

## 素材跨供应商解析

素材库按令牌隔离，因此素材节点的稳定身份不是单独的 `asset://{id}`，而是“来源供应商连接 ID + 素材 ID”。生成节点切换供应商时保留素材连线，但不能把来源令牌下的 `asset://` 直接发送给目标供应商。

Task Module 和提示词视觉输入在调用供应商模块前统一使用素材库 module 的 `resolve` interface：

| 场景                              | 解析方式                                                                |
| --------------------------------- | ----------------------------------------------------------------------- |
| 素材与生成任务使用同一凭据作用域  | 目标协议允许时直接提交 `asset://{id}`                                   |
| 图生图素材来自另一个供应商连接    | 使用来源连接刷新并下载图片字节，再作为有序 multipart 文件提交           |
| 视频生成素材来自另一个供应商连接  | 使用来源连接取得新鲜的短期可读 URL，再映射为目标视频接口的媒体 URL 输入 |
| 目标 Adapter 不接受字节或短期 URL | 保留节点和连线，停止提交并显示实际收到的完整原始错误                    |

素材解析使用来源供应商连接的凭据；生成请求使用目标供应商连接的凭据。两份凭据都只在 Tauri 后端按引用解析。无论素材来自显式端口还是提示词 `@` 引用，任务快照都保存来源连接 ID、素材 ID、引用出现位置、媒体类型、同类型位置及提交时内容标识，但不保存 API Key 或已经可能过期的签名 URL。

素材库 module 对外保持三个深 interface：`browse` 返回规范化记录，`import_staged` 封装分组与导入状态机，`resolve` 按调用意图返回已校验字节或远端可读引用。供应商字段、状态拼写、包络差异、重试与分组缓存都留在 implementation；生产 provider adapter 和内存 test adapter 共用同一 seam。

这条内部 seam 不增加画布或 Provider Adapter 的 Interface：节点仍只提交结构化引用，跨供应商下载、刷新和格式转换全部隐藏在素材库 module 的 implementation 内。

## 媒体顺序契约

图片、视频和音频分别拥有独立的顺序，三个序列都从 `1` 开始。不存在跨媒体类型共享的“素材 1、素材 2”。例如提示内容依次出现图片 A、视频 A、图片 B、音频 A 时，业务位置是 `图片 1、视频 1、图片 2、音频 1`。

- 媒体引用模块先冻结 `images[]`、`videos[]`、`audios[]`，Provider Adapter 只能把这些已编号输入映射为协议字段。
- 图生图 multipart `image[]` 必须严格对应图片序列；视频协议即使使用一个混合的 `metadata.content`，也必须保持图片、视频、音频各自序列内的相对顺序，并保留每项的 `typePosition` 供请求记录审计。
- 跨类型的文字片段先后顺序仍属于结构化提示；它不能被转换成一个跨类型共享的媒体序号。
- 并行下载、刷新素材 URL 或 TOS 暂存只允许按 `(mediaType, typePosition)` 回填结果，完成先后不能改变请求位置。
- 任一位置解析失败时，整次提交在调用供应商前失败；不得删除失败项、压缩后续位置或发送部分输入。
- Adapter 不得按文件名、素材 ID、角色、供应商、文件大小或异步完成时间排序，也不得去重、分组后重编号或把三个序列合成全局位置。

## 生成结果保存目标

图片和视频采用同一个本地结果保存边界：

- 所有图片和视频生成结果都不导入公司素材库。Task Module 把 Adapter 解释出的 URL、Base64、远程 `task_id`、格式和元数据交给独立本地结果保存模块。
- 图片使用 `<Downloads>/无限画布/<safe(localGenerationTaskId)>-<resultIndex>.<extension>`；结果索引从 `1` 开始，单结果也保留 `-1`。
- 视频使用 `<Downloads>/无限画布/<safe(remoteTaskId)>.<extension>`；文件名不包含供应商标识，也不按供应商连接分目录。
- Provider Adapter 只负责保存完整原始成功响应并解释结果来源、远程 `task_id`、格式及元数据，不直接操作文件系统。
- 本地结果保存模块负责 URL 下载、Base64 解码、`.part` 临时文件、文件魔数与哈希校验、原子改名、冲突保护和本地文件记录。
- 同名目标已经存在且内容不同或无法证明相同时，保存状态进入 `conflict` 并完整展示冲突，不覆盖、不添加供应商后缀，也不由 Adapter 改名。
- 图片或视频本地保存失败都不能把已经成功且可能已计费的生成任务改成生成失败；每个结果保留独立保存状态和原始错误。
- 素材库模块只服务于用户主动上传和已有素材管理；本地生成结果以后作为只接受公网 URL 的远程输入时可以按需经过 TOS，但不创建素材记录。

## 节点选择逻辑

节点内部继续显示“供应商、模型、生成数量”：

1. 供应商字段选择一个启用的供应商连接。
2. 模型字段列出该供应商连接中已启用、并且支持当前节点操作类型的模型绑定。
3. 两个供应商都绑定同一模型定义时，切换供应商会选择目标供应商的第一个兼容模型；提示词、图片顺序、视频顺序、音频顺序和连线保持不变。
4. 切换供应商或模型时清空上一模型的参数值，并由新模型 Schema 应用默认值，防止旧字段进入新请求。
5. 目标供应商没有支持当前操作的模型时，模型选择为空且节点不可运行；用户仍可切回原供应商，不需要重建提示词或连线。
6. 生成数量仍由模型定义和真实端点决定；端点没有数量参数时固定为 `1`，统一供应商模块不通过循环请求伪造批量生成。

## 禁止的实现方式

- 不在节点中保存 `baseUrl` 或 API Key。
- 不为每个供应商复制一份 `generateImageA`、`generateImageB`。
- 不按供应商显示名称或域名写 `if/else` 分支；名称推断只使用受测试约束的模型家族标记，供应商明确声明的能力始终优先，无法识别的型号保持未启用。
- 不把供应商、模型和凭据合并成一个不可复用的配置对象。
- 不允许前端直接读取 API Key 明文。
- 不捕获供应商失败后抛出新的笼统错误来替代原始响应。
- 不因切换供应商而删除当前提示词、参数、素材或连线。
- 不把 `@显示名称` 当作素材身份，不让每个 Adapter 各自搜索素材、刷新 URL、重排三个媒体序列或决定输入合并顺序。

## 何时需要新 Adapter

只有以下差异才需要新增 Adapter：

- 鉴权方法不同，例如不再使用相同的 Bearer Token 规则。
- 端点和请求字段不同，且不能由模型操作 Schema 的路径、字段映射与参数容器表达。
- multipart、素材引用或任务轮询协议不同。
- 成功与失败响应的语义不同，继续共用会产生供应商名称分支。

如果差异只有 `baseUrl`、API Key、显示名称或模型是否启用，继续复用现有 Adapter。

## MVP 验收测试

1. 建立供应商 A 和供应商 B，使用相同 Adapter、不同 `baseUrl` 与 API Key 凭据引用，并共同绑定同一个模型定义。
2. 对同一节点快照分别执行 A 和 B；除请求源地址和鉴权值外，请求方法、路径、请求体、图片顺序、视频顺序、音频顺序和远程模型 ID 必须一致。
3. 在 A 与 B 之间切换，模型、提示词、参数和连线保持不变。
4. 切换到未绑定当前模型的供应商，节点只进入不可运行状态，不删除任何配置；切回后恢复。
5. 供应商显示名称改变后，请求行为完全不变，证明执行逻辑没有依赖名称。
6. `baseUrl` 带或不带尾部斜杠时，请求路径均正确且不会出现重复路径段。
7. 画布保存、任务快照、错误面板和诊断导出中均不存在 API Key 明文。
8. 两个供应商返回非 2xx、非 JSON 响应和异步任务失败时，都完整展示各自原始响应，不出现统一错误文案。
9. 视频任务提交后修改节点供应商，轮询仍使用任务提交时冻结的供应商上下文。
10. 把供应商 A 令牌下的素材连接到供应商 B 的生成节点：不得直接转发 A 的 `asset://`；图生图应上传按原顺序解析的文件字节，视频生成应传新鲜的可读 URL，失败时保留连线并展示完整原始错误。
11. 分别用供应商 A 和 B 生成图片；验证结果都进入统一本地保存模块，文件名只使用本地任务 ID 和结果索引，不调用素材导入端点，也不读取另一供应商的凭据。
12. 对成功、HTTP 失败和网络异常分别调用 Adapter，验证发送前已经保存实际非敏感请求，调用后保存完整原始返回或异常，并且后续解析不覆盖原文。
13. 验证 JSON 的实际字段、Adapter 默认值和 multipart 文件顺序及元数据可查询，同时任何任务快照、调用记录或诊断导出均不存在请求凭据和签名参数。
14. 对视频提交和连续状态查询逐次保存调用记录；应用重启后仍可通过原任务查看每次请求和返回，而不是只剩最终状态。
15. 图片提交或视频查询成功后，验证 Provider Adapter 只返回结果源、远程 `task_id`（如有）和元数据，不调用素材导入端点或直接写文件；Task Module 随后启动独立本地保存。
16. 两个供应商返回相同视频 `task_id` 时，验证目标路径仍不增加供应商目录：同内容安全复用，不同内容进入 `conflict` 且不覆盖。
17. 将同一结构化提示分别提交给图生图和视频 Adapter，验证媒体引用模块只解析一次稳定身份与内容，Adapter 只负责各自协议字段映射，不重新按名称查找素材。
18. `@` 引用来自供应商 A、生成任务使用供应商 B 时，验证素材解析使用 A 的凭据、生成请求使用 B 的凭据；任务记录保存两者作用域且不泄露明文。
19. 含媒体引用的文生图命令在进入 Provider Adapter 前失败；验证没有 HTTP 调用，完整本地编译错误可以从任务历史读取。
20. 图生图 Adapter 按媒体引用模块给出的图片序列构造 `image[]`；视频 Adapter 构造 `metadata.content` 时分别保持图片、视频、音频序列的内部顺序和角色。两者都不得自行去重、重排、压缩位置或改写引用身份。
21. 提示内容依次引用图片 A、视频 A、图片 B、音频 A，验证 Provider 实际请求和调用记录中的位置分别为 `图片 1、视频 1、图片 2、音频 1`，没有任何全局“素材 N”。
22. 并行解析四项媒体并让它们以相反顺序完成，验证 Adapter 接收的三个序列及实际请求仍使用冻结的同类型位置。
23. 让 `图片 2` 解析失败，验证整次提交在 HTTP 前失败，不把原来的 `图片 3` 改成 `图片 2`，也不发送部分媒体。
24. 同一任务发生可重试网络错误后，验证每次 Adapter 调用都复用完全相同的三个媒体序列、同类型位置和内容哈希。
