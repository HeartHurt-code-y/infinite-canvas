import { isDesktopRuntime } from "../../lib/backend";

export interface ArtifactDeliveryOutput {
  readonly key: string;
  readonly taskId: string;
  readonly resultKey: string | null;
  readonly sourceNodeId: string;
  readonly origin?: string;
  readonly mediaType: "image" | "video" | "audio" | "text";
  readonly finalPath: string;
  readonly name: string;
}

interface DeliveryEntry extends ArtifactDeliveryOutput {
  readonly deliveryName: string;
  readonly sizeBytes: number;
  readonly sourceModifiedAt: string | null;
}

function safeName(name: string): string {
  const clean = name
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .split("")
    .map((character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? "_" : character,
    )
    .join("")
    .replace(/[. ]+$/, "")
    .slice(0, 80)
    .replace(/[. ]+$/, "");
  if (!clean) return "产物";
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(clean) ? `_${clean}` : clean;
}

function csvCell(value: string | null): string {
  // Prevent a label from becoming a spreadsheet formula when the CSV is opened.
  const text = value != null && /^[=+\-@\t\r]/.test(value) ? `'${value}` : (value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function deliveryCsv(entries: readonly DeliveryEntry[]): string {
  const headers = [
    "key",
    "taskId",
    "resultKey",
    "sourceNodeId",
    "origin",
    "mediaType",
    "name",
    "sourcePath",
    "deliveryName",
    "sizeBytes",
    "sourceModifiedAt",
  ];
  const rows = entries.map((entry) =>
    [
      entry.key,
      entry.taskId,
      entry.resultKey,
      entry.sourceNodeId,
      entry.origin ?? "generation",
      entry.mediaType,
      entry.name,
      entry.finalPath,
      entry.deliveryName,
      String(entry.sizeBytes),
      entry.sourceModifiedAt,
    ]
      .map(csvCell)
      .join(","),
  );
  return `\uFEFF${headers.join(",")}\r\n${rows.join("\r\n")}\r\n`;
}

/**
 * Export selected saved outputs without moving their stable sources. The directory
 * becomes a delivery only after every copy and both identity manifests succeed.
 */
export async function exportArtifactDeliveryToDesktop(
  outputs: readonly ArtifactDeliveryOutput[],
): Promise<string | null> {
  if (!isDesktopRuntime()) throw new Error("按名称交付需要在桌面应用中运行。");
  if (!outputs.length) throw new Error("请选择已保存到本机的产物。");
  const snapshot = outputs.map((output) => ({
    key: output.key,
    taskId: output.taskId,
    resultKey: output.resultKey,
    sourceNodeId: output.sourceNodeId,
    origin: output.origin ?? "generation",
    mediaType: output.mediaType,
    finalPath: output.finalPath,
    name: output.name,
  }));
  if (snapshot.some((output) => !output.key || !output.finalPath.trim()))
    throw new Error("产物缺少本地文件或稳定身份。");
  if (new Set(snapshot.map((output) => output.key)).size !== snapshot.length)
    throw new Error("交付清单包含重复产物节点。");

  const [{ open }, fs, paths] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/plugin-fs"),
    import("@tauri-apps/api/path"),
  ]);
  const selected = await open({ title: "选择按名称交付的位置", directory: true, multiple: false });
  if (typeof selected !== "string" || !selected) return null;
  const parent = await paths.resolve(selected);
  if (!(await paths.isAbsolute(parent))) throw new Error("交付位置必须是绝对路径。");
  const deliveryId = crypto.randomUUID();
  const directoryName = `无限画布交付-${deliveryId}`;
  const stagingName = `.${directoryName}.partial`;
  const directory = await paths.resolve(await paths.join(parent, directoryName));
  const staging = await paths.resolve(await paths.join(parent, stagingName));
  // Check the actual absolute deletion target before creating any files. Only this
  // new direct child may ever be recursively cleaned up, including on Windows.
  if (
    (await paths.dirname(staging)) !== parent ||
    (await paths.basename(staging)) !== stagingName ||
    (await paths.dirname(directory)) !== parent ||
    (await paths.basename(directory)) !== directoryName
  ) {
    throw new Error("交付目录超出了所选位置。");
  }
  if ((await fs.exists(directory)) || (await fs.exists(staging)))
    throw new Error("交付目录已存在，请重试。");

  const measured = await Promise.all(
    snapshot.map(async (output) => {
      if (!(await paths.isAbsolute(output.finalPath)))
        throw new Error(`产物不是有效本地路径：${output.name}`);
      const info = await fs.stat(output.finalPath);
      if (!info.isFile || info.size <= 0) throw new Error(`产物文件不可读取或为空：${output.name}`);
      return { output, info };
    }),
  );
  const usedNames = new Set(["manifest.json", "delivery.csv"]);
  const entries: DeliveryEntry[] = measured.map(({ output, info }) => {
    const sourceFile = output.finalPath.split(/[\\/]/).pop() ?? "";
    const dot = sourceFile.lastIndexOf(".");
    const extension = dot > 0 ? sourceFile.slice(dot) : "";
    let stem = safeName(output.name);
    if (extension && stem.toLowerCase().endsWith(extension.toLowerCase()))
      stem = stem.slice(0, -extension.length);
    stem = safeName(stem);
    let deliveryName = `${stem}${extension}`;
    let suffix = 2;
    const comparable = (value: string) => value.normalize("NFKC").toLowerCase();
    while (usedNames.has(comparable(deliveryName)))
      deliveryName = `${stem}-${String(suffix++).padStart(2, "0")}${extension}`;
    if (/[\\/]/.test(deliveryName) || deliveryName === "." || deliveryName === "..")
      throw new Error("交付文件名无效。");
    usedNames.add(comparable(deliveryName));
    return {
      ...output,
      deliveryName,
      sizeBytes: info.size,
      sourceModifiedAt: info.mtime?.toISOString() ?? null,
    };
  });

  let created = false;
  try {
    // recursive:false prevents claiming or removing an already existing directory.
    await fs.mkdir(staging, { recursive: false });
    created = true;
    for (const entry of entries) {
      const target = await paths.join(staging, entry.deliveryName);
      await fs.copyFile(entry.finalPath, target);
      const [sourceInfo, targetInfo] = await Promise.all([
        fs.stat(entry.finalPath),
        fs.stat(target),
      ]);
      if (
        !sourceInfo.isFile ||
        sourceInfo.size !== entry.sizeBytes ||
        (sourceInfo.mtime?.toISOString() ?? null) !== entry.sourceModifiedAt ||
        !targetInfo.isFile ||
        targetInfo.size !== entry.sizeBytes
      ) {
        throw new Error(`复制期间产物发生变化或复制不完整：${entry.name}`);
      }
    }
    await fs.writeTextFile(
      await paths.join(staging, "manifest.json"),
      JSON.stringify(
        {
          schema: "infinite-canvas-artifact-delivery",
          version: 1,
          deliveryId,
          createdAt: new Date().toISOString(),
          entries,
        },
        null,
        2,
      ),
    );
    await fs.writeTextFile(await paths.join(staging, "delivery.csv"), deliveryCsv(entries));
    if (await fs.exists(directory)) throw new Error("交付目录已存在，未覆盖旧交付。");
    await fs.rename(staging, directory);
    return directory;
  } catch (reason) {
    if (created) {
      try {
        const verified = await paths.resolve(staging);
        if (
          verified !== staging ||
          (await paths.dirname(verified)) !== parent ||
          (await paths.basename(verified)) !== stagingName
        ) {
          throw new Error("清理目标超出了所选位置。", { cause: reason });
        }
        await fs.remove(verified, { recursive: true });
      } catch (cleanupReason) {
        const error =
          cleanupReason instanceof Error ? cleanupReason.message : String(cleanupReason);
        throw new AggregateError(
          [reason, cleanupReason],
          `交付未完成，临时文件未能清理：${staging}。${error}`,
          { cause: cleanupReason },
        );
      }
    }
    throw reason;
  }
}
