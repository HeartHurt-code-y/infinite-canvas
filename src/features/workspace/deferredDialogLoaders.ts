export const loadHistoryDialog = () => import("../history/HistoryDialog");
export const loadProviderSettingsDialog = () => import("../settings/ProviderSettingsDialog");

export function preloadHistoryDialog(): void {
  void loadHistoryDialog();
}

export function preloadProviderSettingsDialog(): void {
  void loadProviderSettingsDialog();
}
