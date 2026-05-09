// Typed API client. Wraps fetch() with the Bearer header and a
// uniform error shape; throws ApiError on non-2xx.

import { loadConfig } from '../config.js';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiOptions {
  hubUrl?: string;            // overrides config
  token?:  string | null;     // overrides config; null = no Authorization header
  signal?: AbortSignal;
}

function buildRequestHeaders(body: unknown | undefined, token: string | null | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

function parseResponseBody(text: string): any {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { error: text }; }
}

function buildApiError(status: number, parsed: any): ApiError {
  const code = parsed?.error || `http_${status}`;
  const msg  = typeof parsed?.message === 'string' ? parsed.message : code;
  return new ApiError(status, code, msg);
}

async function request<T>(
  method: string,
  path: string,
  body: unknown | undefined,
  opts: ApiOptions = {},
): Promise<T> {
  const cfg = loadConfig();
  const hubUrl = (opts.hubUrl ?? cfg.hubUrl).replace(/\/$/, '');
  const token  = opts.token === undefined ? cfg.sessionToken : opts.token;

  const res = await fetch(`${hubUrl}${path}`, {
    method,
    headers: buildRequestHeaders(body, token),
    body:    body !== undefined ? JSON.stringify(body) : undefined,
    signal:  opts.signal,
  });

  if (res.status === 204) return undefined as T;

  const parsed = parseResponseBody(await res.text());
  if (!res.ok) throw buildApiError(res.status, parsed);
  return parsed as T;
}

export const api = {
  get:    <T>(path: string, opts?: ApiOptions)                          => request<T>('GET',    path, undefined, opts),
  post:   <T>(path: string, body?: unknown, opts?: ApiOptions)          => request<T>('POST',   path, body,      opts),
  patch:  <T>(path: string, body?: unknown, opts?: ApiOptions)          => request<T>('PATCH',  path, body,      opts),
  delete: <T>(path: string, opts?: ApiOptions)                          => request<T>('DELETE', path, undefined, opts),
};
