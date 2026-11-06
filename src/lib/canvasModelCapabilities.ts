import catalog from "../../shared/canvas-model-capabilities.json";
import type { GenerationOperation } from "./backend";

interface ModelSelector {
  readonly models?: readonly string[];
  readonly prefixes?: readonly string[];
  readonly adapters?: readonly string[];
}

export interface VideoModelCapabilities {
  readonly modes: readonly string[];
  readonly inputKinds: readonly string[];
  readonly requiredKind?: string;
  readonly maxImages?: number;
  readonly veo?: string;
  readonly reason: string;
}

function matches(selector: ModelSelector, adapter: string, id: string): boolean {
  return (!selector.adapters || selector.adapters.includes(adapter)) &&
    ((!selector.models && !selector.prefixes) || selector.models?.includes(id) === true ||
      selector.prefixes?.some(prefix => id.startsWith(prefix)) === true);
}

export function modelOperationRestriction(
  adapter: string,
  modelId: string,
  operation: GenerationOperation,
): string | undefined {
  const id = modelId.trim().toLowerCase();
  return retiredModelReason(adapter, id) ?? catalog.restrictedOperations.find(rule =>
    rule.operations.includes(operation) && matches(rule, adapter, id)
  )?.reason;
}

export function retiredModelReason(adapter: string, modelId: string): string | undefined {
  const id = modelId.trim().toLowerCase();
  return catalog.retiredModels.find(rule => matches(rule, adapter, id))?.reason;
}

export function videoModelCapabilities(adapter: string, modelId: string): VideoModelCapabilities | undefined {
  const id = modelId.trim().toLowerCase();
  return catalog.video.find(rule => matches(rule, adapter, id));
}

export function pixverseActionRestriction(modelId: string, action: string): string | undefined {
  const id = modelId.trim().toLowerCase();
  return catalog.pixverse.find(rule => matches(rule, "", id) &&
    (rule.actions?.includes(action) || (rule.exceptActions && !rule.exceptActions.includes(action)))
  )?.reason;
}
