# 项目长期记忆（Creata / 无限画布）

## 供应商模型绑定与操作 Schema 约定（关键不变量）

- 模型定义 ID 全局规范：`remote::{provider_connection_id}::{remote_model_id}`
  （`model_schema.rs::provider_scoped_model_definition_id`）。前端所有构造/透传点必须对齐，不信任来源 ID。
- 操作 Schema 硬约束：每个操作条目（`text_to_image`/`image_to_image`/`video_generation`）
  必须带 **`parameters` 对象** 与正确 **`resultType`**（由操作键决定），且含 `requestProfileId`/`request`。
- **修复汇聚点**：`schema_for_enabled_operations`（model_schema.rs）以 `default_operation_schema` 为基底合并历史字段，
  强制补齐缺失的 `parameters`——任何落库/透传的畸形 schema 在此被兜底修复。
- **保存链路多道校验门**：scoping 校验先于 schema 校验。任一道更早失败会遮蔽下游真实问题，排障须逐道剥离。
- **存量修复迁移**：`Storage::open` 启动链 = `seed_model_definitions` → `migrate_legacy_model_bindings`（裸 ID→scoped）→
  `repair_malformed_model_definitions`（畸形 schema 修复 + 删除 `remote::{model}` 非法孤儿行）。均幂等、每次启动执行。
- 注意：seed 仅覆盖已知 id；**实时从 API 拉取的模型**的畸形数据只能靠全表修复迁移兜底，不要假设 seed 覆盖。

## 严格完工链路（用户硬性要求）

代码 + ADR + GitHub issue + eslint + vitest + tsc + cargo fmt + cargo clippy(`-D warnings`) 全部通过，
方可声明完成。交付物以官方源为锚，第三方经验附校准说明；方案边界/已拒备选/trade-off 保持诚实。
