export async function copyTextToDesktopClipboard(text: string): Promise<void> {
  const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
  await writeText(text);
}

export async function revealDesktopItem(path: string): Promise<void> {
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}

export async function openExternalUrl(url: string): Promise<void> {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

export async function saveMarkdownDocumentToDesktop(
  content: string,
  defaultPath: string,
  filterName: string,
): Promise<string | null> {
  const [{ save }, { writeTextFile }] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/plugin-fs"),
  ]);
  const filePath = await save({
    defaultPath,
    filters: [{ name: filterName, extensions: ["md", "markdown"] }],
  });
  if (!filePath) return null;
  await writeTextFile(filePath, content);
  return filePath;
}

/** Export a cohesive delivery into its own directory, without overwriting earlier exports. */
export async function saveWorkflowBundleToDesktop(
  files: readonly { readonly fileName: string; readonly content: string }[],
  title = "动漫短剧",
): Promise<string | null> {
  const [{ open }, { mkdir, writeTextFile }, { join }] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/plugin-fs"),
    import("@tauri-apps/api/path"),
  ]);
  const parent = await open({ title: `选择${title}交付文件夹`, directory: true, multiple: false });
  if (typeof parent !== "string" || !parent) return null;
  const folder = await join(
    parent,
    `${title.replace(/[\\/:*?"<>|]/g, "_")}-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 6)}`,
  );
  await mkdir(folder);
  for (const file of files) {
    if (/[\\/]/.test(file.fileName) || file.fileName === "." || file.fileName === "..") {
      throw new Error("交付文件名无效。");
    }
    await writeTextFile(await join(folder, file.fileName), file.content);
  }
  return folder;
}
