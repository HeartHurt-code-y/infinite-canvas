export async function copyTextToDesktopClipboard(text: string): Promise<void> {
  const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
  await writeText(text);
}

export async function revealDesktopItem(path: string): Promise<void> {
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
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
