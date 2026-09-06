import { invoke } from "@tauri-apps/api/core";
import type { CommerceSource } from "../features/workspace/commerceWorkflowModel";

export interface CommerceSourceClient {
  fetch(urls: readonly string[]): Promise<readonly CommerceSource[]>;
}
export const commerceSourceClient: CommerceSourceClient = {
  fetch: (urls) => invoke<CommerceSource[]>("fetch_commerce_sources", { urls }),
};
