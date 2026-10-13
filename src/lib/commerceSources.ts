import * as v from "valibot";
import type { CommerceSource } from "../features/workspace/commerceWorkflowModel";
import { invokeDesktop } from "./ipc";

export interface CommerceSourceClient {
  fetch(urls: readonly string[]): Promise<readonly CommerceSource[]>;
}

const commerceSourceSchema = v.object({
  url: v.string(),
  title: v.string(),
  text: v.string(),
  status: v.picklist(["fetched", "failed"]),
  error: v.optional(v.nullable(v.string())),
});

export const commerceSourceClient: CommerceSourceClient = {
  fetch: (urls) => invokeDesktop("fetch_commerce_sources", v.array(commerceSourceSchema), { urls }),
};
