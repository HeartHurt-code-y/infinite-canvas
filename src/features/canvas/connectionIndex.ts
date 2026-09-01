interface OrderedCanvasInput {
  readonly edgeId: string;
}

/** 已归一化输入列表的数组下标就是画布连线序号；构建后每条边可 O(1) 读取。 */
export function buildInputOrderByEdge(
  ...inputGroups: readonly ReadonlyMap<string, readonly OrderedCanvasInput[]>[]
): ReadonlyMap<string, number> {
  const orderByEdge = new Map<string, number>();
  for (const groups of inputGroups) {
    for (const inputs of groups.values()) {
      inputs.forEach((input, index) => orderByEdge.set(input.edgeId, index + 1));
    }
  }
  return orderByEdge;
}
