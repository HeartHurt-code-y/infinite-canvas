export const loadHistoryDialog = () => import("../history/HistoryDialog");
export const loadProviderSettingsDialog = () => import("../settings/ProviderSettingsDialog");
export const loadAssetSourceDialog = () => import("./AssetLibraryViews");
export const loadAssetGroupCreateDialog = () => import("./AssetLibraryViews");
export const loadRealPersonAssetDialog = () => import("./AssetLibraryViews");

export function preloadHistoryDialog(): void {
  void loadHistoryDialog();
}

export function preloadProviderSettingsDialog(): void {
  void loadProviderSettingsDialog();
}
