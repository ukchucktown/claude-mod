// Integration-owned contracts. These are not generated provider declarations.
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type RpcId = string | number;
export type Caller = Readonly<{
  sessionId: string;
  agentId?: string;
  turnId: string;
  toolUseId: string;
  runtimeGeneration: string;
}>;
export type ToolResult = {
  content: Array<{ type: string; [key: string]: Json }>;
  isError?: boolean;
  structuredContent?: Json;
  _meta?: Record<string, Json>;
};
export type ServerRequest = {
  jsonrpc: "2.0";
  id: RpcId;
  method: string;
  params: Record<string, Json>;
};
export type Decision = {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, Json>;
  _meta?: Record<string, Json>;
};
// operationId is unique for each pending request. A decision must carry the ID
// of the request it answers, so a handle saved from a cancelled call cannot
// resolve a replacement call with the same caller and server request.
export type PendingRequest = Readonly<{
  operationId: string;
  caller: Caller;
  request: ServerRequest;
}>;
export type LifecycleEvent =
  | {
      type: "turn.complete";
      sessionId: string;
      turnId: string;
      agentId?: string;
      isAborted: boolean;
    }
  | { type: "session.end"; sessionId: string; reason: string };
