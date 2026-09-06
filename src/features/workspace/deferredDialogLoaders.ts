export const loadHistoryDialog = () => import("../history/HistoryDialog");
export const loadProviderSettingsDialog = () => import("../settings/ProviderSettingsDialog");
export const loadAssetSourceDialog = () => import("./AssetDialogs");
export const loadAssetGroupCreateDialog = () => import("./AssetDialogs");
export const loadRealPersonAssetDialog = () => import("./AssetDialogs");

export function preloadHistoryDialog(): void {
  void loadHistoryDialog();
}

export function preloadProviderSettingsDialog(): void {
  void loadProviderSettingsDialog();
}
