import type {
  Caller,
  Decision,
  Json,
  LifecycleEvent,
  PendingRequest,
  ToolResult,
} from "../contracts.ts";

// RuntimeSupervisor supplies the process/stdio implementation. An owner retains the
// original call while a server request awaits an explicit decision.
export interface ConnectionOwner {
  call(
    caller: Caller,
    tool: string,
    args: Record<string, Json>,
  ): Promise<ToolResult>;
  pending(): readonly PendingRequest[];
  answer(pending: PendingRequest, decision: Decision): void;
  lifecycle(event: LifecycleEvent): void;
  close(): void;
}
