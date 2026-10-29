/*
 * 创作台的「平台 → 模型」二级分类。
 *
 * 目录里同一个模型可能挂在多个供应商连接下（同名模型、不同来路）。
 * 把所有平台的所有模型塞进一个下拉，用户只能靠一行灰色小字
 * （「平台 · 远端模型 ID」）分辨自己在选哪个——几十条同名项，
 * 选中之前根本看不出区别。
 *
 * 这里按**供应商连接**（providerConnectionId）分组：先选平台，
 * 再在该平台里选模型。
 *
 * 分组顺序 = 目录里的出现顺序（后端 `list_generation_models` 的返回序），
 * 不额外排序：目录的第一条模型默认就是提交时的默认模型，
 * 顺序一改，「默认」的口径就跟着漂了。
 */

/** 分组所需的最小结构：任何带供应商信息的模型项都能用。 */
export interface PlatformModelEntry {
  /** 供应商连接 id：同一平台的模型靠它归拢。 */
  readonly providerConnectionId: string;
  /** 平台展示名（用户自己起的连接名，例如「海外平台」）。 */
  readonly providerName: string;
}

export interface PlatformGroup<T extends PlatformModelEntry> {
  /** 平台标识（供应商连接 id）。 */
  readonly id: string;
  /** 平台展示名。 */
  readonly name: string;
  /** 该平台下的模型，保持目录里的原始顺序。 */
  readonly models: readonly T[];
}

/**
 * 按供应商连接把模型分组。
 *
 * 平台的身份用**连接 id**而不是展示名：两个连接可能取同一个名字
 * （用户自己起的名），但它们是两套接口、两套凭据，必须分开选。
 */
export function groupModelsByPlatform<T extends PlatformModelEntry>(
  models: readonly T[],
): readonly PlatformGroup<T>[] {
  const groups = new Map<string, { name: string; models: T[] }>();
  for (const item of models) {
    const existing = groups.get(item.providerConnectionId);
    if (existing) {
      existing.models.push(item);
      continue;
    }
    groups.set(item.providerConnectionId, { name: item.providerName, models: [item] });
  }
  return [...groups.entries()].map(([id, group]) => ({
    id,
    name: group.name,
    models: group.models,
  }));
}
