// Bidirectional WS message shapes for both transports.
//
//   /channel  — channel_v1 MCP ↔ hub
//   /cli      — `claw attach` ↔ hub
//
// Each message has a discriminator `type` field. correlationId is
// optional but used for any request that expects an asynchronous
// response (routing, probes, permission decisions).

// ─── /channel — MCP-side ────────────────────────────────────────────

export type ChannelOutbound =
  | { type: 'register'; host: string; cwd: string; osUser: string | null; pid: number; channelVersion: string; sessionId: string | null }
  | { type: 'chat_event'; eventType: 'prompt' | 'reply'; payload: Record<string, unknown>; ts: string }
  | { type: 'tail_event'; eventType: 'PreToolUse' | 'PostToolUse' | 'Stop' | 'Notification' | 'UserPromptSubmit'; payload: Record<string, unknown>; ts: string }
  | { type: 'permission_request'; requestId: string; tool: string; inputPreview: string; ts: string }
  | { type: 'route_request'; correlationId: string; peer: string; prompt: string; mode: 'ask' | 'tell' }
  | { type: 'probe_request'; correlationId: string; peers: string[] | null; prompt: string }
  | { type: 'list_peers_request'; correlationId: string }
  | { type: 'pong'; ts: string };

export type ChannelInbound =
  | { type: 'welcome'; sessionId: string; routingName: string; channelTokenName: string }
  | { type: 'prompt'; chatId: string; text: string }
  | { type: 'permission_response'; requestId: string; decision: 'allow' | 'deny' | 'expired'; message: string | null }
  | { type: 'route_response'; correlationId: string; peerLogin: string; reply: string }
  | { type: 'route_reply'; routeId: string; fromName: string; text: string; ts: string; origin?: 'operator' | 'mcp' }
  | { type: 'probe_response'; correlationId: string; peerLogin: string; answer: string | null }
  | { type: 'peers_update'; peers: { login: string; name: string; online: boolean }[] }
  | { type: 'list_peers_response'; correlationId: string; peers: { login: string; name: string; online: boolean }[] }
  | { type: 'bye'; reason: string; retry: boolean }
  | { type: 'ping'; ts: string }
  | { type: 'error'; code: string; message: string };

// ─── /cli — operator-side ───────────────────────────────────────────

export type CliOutbound =
  | { type: 'subscribe'; sessionId: string }
  | { type: 'unsubscribe'; sessionId: string }
  | { type: 'prompt'; sessionId: string; text: string; sourceSessionId?: string; attachments?: number[] }
  | { type: 'op_message'; sessionId: string; text: string; mentions?: string[] }
  | { type: 'approval'; sessionId: string; requestId: string; decision: 'allow' | 'deny'; message?: string }
  | { type: 'route'; peer: string; prompt: string; mode: 'ask' | 'tell' };

export type CliInbound =
  | { type: 'subscribed'; sessionId: string; role: 'owner' | 'viewer' | 'prompter' | 'approver' }
  | { type: 'event'; sessionId: string; event: { kind: 'chat' | 'tail'; type: string; payload: Record<string, unknown>; ts: string } }
  | { type: 'op_message'; sessionId: string; authorLogin: string; text: string; mentions: string[]; ts: string }
  | { type: 'permission_request'; sessionId: string; requestId: string; tool: string; inputPreview: string; ts: string }
  | { type: 'permission_resolved'; sessionId: string; requestId: string; decision: 'allow' | 'deny' | 'expired'; resolverLogin: string | null }
  | { type: 'presence'; sessionId: string; attached: string[]; joined?: string; left?: string }
  | { type: 'channel_status'; sessionId: string; connected: boolean; ts: string }
  | { type: 'file_event'; sessionId: string; action: 'uploaded' | 'deleted' | 'referenced'; file: ApiFile }
  | { type: 'chat_reply_chunk'; sessionId: string; chatId: string; text: string; done: boolean }
  | { type: 'ack'; ok: true }
  | { type: 'error'; ok: false; code: string; message: string };

// Forward declaration so CliInbound's file_event variant can reference
// it without forcing api-types to import this module. The runtime
// shape is identical to ApiFile in api-types.ts; kept here so the
// WS protocol stays self-contained.
import type { ApiFile } from './api-types.js';
