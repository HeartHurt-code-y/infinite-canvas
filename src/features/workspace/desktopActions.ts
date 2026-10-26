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

/** Copy the stable source to a user-selected filename without moving referenced media. */
export async function exportArtifactToDesktop(
  sourcePath: string,
  fileName: string,
): Promise<string | null> {
  const [{ save }, { copyFile }, { dirname, join }] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/plugin-fs"),
    import("@tauri-apps/api/path"),
  ]);
  const target = await save({
    title: "导出产物",
    defaultPath: await join(await dirname(sourcePath), fileName),
  });
  if (!target || target === sourcePath) return target;
  await copyFile(sourcePath, target);
  return target;
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
