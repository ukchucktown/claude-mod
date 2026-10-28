import type { Decision, PendingRequest } from "../contracts.ts";

export interface PolicyBoundary {
  decide(request: PendingRequest): Promise<Decision>;
}

// No policy implementation exists in the scaffold. Missing consent cannot
// accidentally turn into approval when a consumer wires this boundary.
export const unavailablePolicy: PolicyBoundary = {
  async decide() {
    return { action: "cancel" };
  },
};
