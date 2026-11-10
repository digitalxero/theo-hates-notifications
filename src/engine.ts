import { mkdir, readFile, open, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PluginNotification, PluginNotificationBatch, PluginNotificationRoutes } from "@t3tools/plugin-sdk";

export const kinds = ["completion", "input", "approval", "failure", "usage-limit", "guest-request", "activity", "clear", "notice", "review-ready", "review-failure"] as const;
export const defaultKinds = kinds.filter(kind => !["activity", "clear", "notice"].includes(kind));
export const transports = ["slack", "ntfy", "webhook", "discord", "gotify", "mobile"] as const;
export interface Destination {
  id: string;
  name: string;
  transport: typeof transports[number];
  enabled: boolean;
  events: string[];
  projects: string[];
  providers: string[];
}
interface Delivery {
  id: string;
  destination: Destination;
  event: PluginNotification;
  attempts: number;
  nextAttempt: number;
  status: "pending" | "delivered" | "failed" | "discarded";
  result?: string;
}
interface State {
  version: 1;
  cursor: number | null;
  destinations: Destination[];
  deliveries: Delivery[];
  clientRoutes: PluginNotificationRoutes;
  appUrl: string;
  noticesEnabled: boolean;
  noticeDetails: boolean;
}
export interface Dependencies {
  environmentId?: string;
  native?: (threadId: string, signal?: AbortSignal) => Promise<void>;
  secret: (key: string) => Promise<string | null>;
  fetch?: typeof fetch;
  now?: () => number;
}
const empty = (): State => ({ version: 1, cursor: null, destinations: [], deliveries: [], clientRoutes: [], appUrl: "https://app.t3.codes", noticesEnabled: false, noticeDetails: false });
const validId = (id: string) => /^[a-z][a-z0-9-]{0,51}$/.test(id);
export function destination(input: unknown): Destination {
  if (typeof input !== "object" || input === null) throw new Error("Destination must be an object.");
  const d = input as Destination;
  if (!validId(d.id) || typeof d.name !== "string" || !d.name.trim() || d.name.length > 200 ||
      !transports.includes(d.transport) || typeof d.enabled !== "boolean") throw new Error("Invalid destination identity or transport.");
  for (const field of ["events", "projects", "providers"] as const) {
    if (!Array.isArray(d[field]) || d[field].length > 100 || d[field].some(x => typeof x !== "string" || x.length > 16384)) throw new Error("Invalid route filters.");
  }
  if (!d.events.length || d.events.some(x => !kinds.includes(x as typeof kinds[number]))) throw new Error("Select at least one supported event.");
  return { id: d.id, name: d.name.trim(), transport: d.transport, enabled: d.enabled, events: [...new Set(d.events)], projects: [...new Set(d.projects)], providers: [...new Set(d.providers)] };
}
export function matches(d: Destination, event: PluginNotification): boolean {
  return d.enabled && !(d.transport === "mobile" && ["notice", "review-ready", "review-failure"].includes(event.kind)) && d.events.includes(event.kind) && (!d.projects.length || d.projects.includes(event.projectId)) && (!d.providers.length || d.providers.includes(event.provider));
}
export function endpoint(value: string): URL {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("Use an HTTP(S) endpoint without URL user information or fragments.");
  return url;
}
export function endpointConfiguration(value: string) {
  const parsed: unknown = value.trim().startsWith("{") ? JSON.parse(value) : { url: value, headers: {} };
  if (typeof parsed !== "object" || parsed === null || !("url" in parsed) || typeof parsed.url !== "string") throw new Error("Invalid endpoint configuration.");
  const supplied = "headers" in parsed ? parsed.headers : {};
  if (typeof supplied !== "object" || supplied === null || Array.isArray(supplied)) throw new Error("Headers must be a JSON object.");
  const headers: Record<string,string> = {};
  for (const [key, value] of Object.entries(supplied)) {
    if (typeof value !== "string" || value.length > 8192 || ["host","content-length","connection","transfer-encoding","idempotency-key"].includes(key.toLowerCase())) throw new Error("Invalid custom header.");
    headers[key] = value;
  }
  if (Object.keys(headers).length > 20) throw new Error("Too many custom headers.");
  new Headers(headers);
  return { url: endpoint(parsed.url).href, headers };
}
export function request(d: Destination, e: PluginNotification, target: string, id: string, link?: string): { url: string; init: RequestInit } {
  const url = endpoint(target);
  const title = `${e.kind}: ${e.title}` + (e.description ? `\n${e.description}` : "");
  let body: unknown = { id, event: e, ...(link ? { url: link } : {}) };
  const headers: Record<string,string> = { "Content-Type": "application/json", "Idempotency-Key": id };
  switch (d.transport) {
    case "slack": body = { text: title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;") + (link ? `\n<${link}|Open thread>` : "") }; break;
    case "discord": body = { content: title.slice(0, Math.max(0, 2000 - (link ? link.length + 1 : 0))) + (link ? `\n${link}` : ""), allowed_mentions: { parse: [] } }; break;
    case "ntfy": headers["Content-Type"] = "text/plain; charset=utf-8"; headers["Title"] = "T3 Code"; if (link) headers["Click"] = link; body = title; break;
    case "gotify": body = { title: "T3 Code", message: title + (link ? `\n${link}` : ""), priority: e.kind === "approval" || e.kind === "input" ? 8 : 5 }; break;
  }
  return { url: url.href, init: { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body), redirect: "error" } };
}

export async function createEngine(directory: string, dependencies: Dependencies) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, "routing.json");
  let state = empty();
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as State;
    if (parsed.version !== 1 || !Array.isArray(parsed.deliveries) || parsed.deliveries.length > 10000 ||
        (parsed.cursor !== null && (!Number.isSafeInteger(parsed.cursor) || parsed.cursor < 0))) throw new Error("Invalid routing state.");
    parsed.destinations = parsed.destinations.map(destination);
    parsed.clientRoutes ??= [];
    parsed.noticesEnabled ??= false;
    parsed.noticeDetails ??= false;
    parsed.appUrl ??= "https://app.t3.codes";
    state = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const now = dependencies.now ?? Date.now;
  const send = dependencies.fetch ?? fetch;
  let lane = Promise.resolve();
  const serial = <A>(work: () => Promise<A>): Promise<A> => {
    const result = lane.then(work);
    lane = result.then(() => undefined, () => undefined);
    return result;
  };
  const persist = async (next: State) => {
    const pending = next.deliveries.filter(d => d.status === "pending");
    if (Buffer.byteLength(JSON.stringify(pending)) > 4 * 1024 * 1024) throw new Error("Delivery queue storage limit reached; cursor retained.");
    const history: Delivery[] = [];
    let historyBytes = 0;
    for (const entry of next.deliveries.filter(d => d.status !== "pending").reverse()) {
      historyBytes += Buffer.byteLength(JSON.stringify(entry));
      if (history.length >= 1000 || historyBytes > 1024 * 1024) break;
      history.push(entry);
    }
    next.deliveries = [...history.reverse(), ...pending];
    const encoded = JSON.stringify(next);
    if (Buffer.byteLength(encoded) > 8 * 1024 * 1024) throw new Error("Routing state storage limit reached.");
    const temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(encoded); await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
    state = next;
  };
  const update = (run: (next: State) => void) => serial(async () => { const next = structuredClone(state); run(next); await persist(next); });
  return {
    state: () => structuredClone(state),
    configureNotices: (enabled: boolean, details: boolean) => update(next => { next.noticesEnabled = enabled; next.noticeDetails = details; }),
    enqueueNotice: (event: PluginNotification) => update(next => {
      if (!next.noticesEnabled) return;
      const seen = new Set(next.deliveries.map(d => d.id));
      for (const d of next.destinations.filter(d => matches(d, event))) {
        const id = encodeURIComponent(`${dependencies.environmentId ?? "local"}:${event.id}:${d.id}`);
        if (seen.has(id)) continue;
        if (next.deliveries.filter(d => d.status === "pending").length >= 9000) throw new Error("Delivery queue full.");
        next.deliveries.push({ id, destination: d, event, status: "pending", attempts: 0, nextAttempt: 0 });
      }
    }),
    setAppUrl: (value: string) => update(next => {
      const url = endpoint(value);
      if (url.search) throw new Error("The client URL must not contain credentials or query parameters.");
      next.appUrl = url.href.replace(/\/$/, "");
    }),
    setClientRoutes: (routes: PluginNotificationRoutes) => update(next => { next.clientRoutes = structuredClone(routes); }),
    configure: (value: unknown) => update(next => {
      const d = destination(value);
      if (!next.destinations.some(x => x.id === d.id) && next.destinations.length >= 50) throw new Error("Destination limit reached.");
      next.destinations = [...next.destinations.filter(x => x.id !== d.id), d];
    }),
    remove: (id: string) => update(next => {
      next.destinations = next.destinations.filter(d => d.id !== id);
      next.deliveries = next.deliveries.map(d => d.destination.id === id && d.status === "pending" ? { ...d, status: "discarded", result: "Destination removed" } : d);
    }),
    ingest: (batch: PluginNotificationBatch) => update(next => {
      if (next.cursor !== null && batch.cursor < next.cursor) throw new Error("Notification cursor moved backwards.");
      const seen = new Set(next.deliveries.map(d => d.id));
      for (const e of batch.events) {
        if (next.cursor !== null && e.sequence <= next.cursor) continue;
        for (const d of next.destinations.filter(d => matches(d, e))) {
          const id = encodeURIComponent(`${dependencies.environmentId ?? "local"}:${e.id}:${d.id}`);
          if (seen.has(id)) continue;
          next.deliveries.push({ id, destination: d, event: e, status: "pending", attempts: 0, nextAttempt: 0 });
          seen.add(id);
        }
      }
      const pending = next.deliveries.filter(d => d.status === "pending");
      if (pending.length > 9000) throw new Error("Delivery queue full; notification cursor retained.");
      next.deliveries = [...next.deliveries.filter(d => d.status !== "pending").slice(-1000), ...pending];
      next.cursor = batch.cursor;
    }),
    retry: (id: string) => update(next => {
      const d = next.deliveries.find(d => d.id === id);
      if (!d || d.status !== "failed") throw new Error("Only failed deliveries can be retried.");
      d.status = "pending"; d.attempts = 0; d.nextAttempt = 0; delete d.result;
    }),
    drain: (signal?: AbortSignal) => serial(async () => {
      for (const delivery of state.deliveries.filter(d => d.status === "pending" && d.nextAttempt <= now() && state.destinations.some(route => route.id === d.destination.id && route.enabled)).slice(0, 1)) {
        if (signal?.aborted) return;
        if (!state.destinations.some(d => d.id === delivery.destination.id && d.enabled)) continue;
        const next = structuredClone(state);
        const record = next.deliveries.find(d => d.id === delivery.id)!;
        record.attempts++;
        // Reserve the attempt before HTTP; an interrupted request has an uncertain remote outcome.
        record.nextAttempt = now() + Math.min(300000, 1000 * 2 ** record.attempts);
        if (record.attempts > 5) { record.status = "failed"; record.result = "Attempt limit reached"; await persist(next); continue; }
        await persist(next);
        let result: string;
        let retryable = true;
        let retryAfter = record.nextAttempt;
        try {
          if (record.destination.transport === "mobile") {
            if (!dependencies.native) { result = "Native host delivery unavailable"; retryable = false; }
            else { await dependencies.native(record.event.sourceThreadId ?? record.event.threadId, signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000)); result = "Native refresh requested"; }
          } else {
          const target = await dependencies.secret(`destination-${record.destination.id}`);
          if (!target) { result = "Endpoint secret missing"; retryable = false; }
          else {
            const path = record.event.path;
            const link = path?.startsWith("/") && !path.startsWith("//") && !path.includes("\\") && !path.includes("#")
              ? new URL(path, state.appUrl).href
              : dependencies.environmentId ? `${state.appUrl}/${encodeURIComponent(record.event.targetEnvironmentId ?? dependencies.environmentId)}/${encodeURIComponent(record.event.threadId)}` : undefined;
            const configuration = endpointConfiguration(target);
            const req = request(record.destination, record.event, configuration.url, record.id, link);
            const response = await send(req.url, { ...req.init, headers: { ...req.init.headers, ...configuration.headers }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
            await response.body?.cancel();
            result = response.ok ? "Delivered" : `HTTP ${response.status}`;
            retryable = response.status === 408 || response.status === 429 || response.status >= 500;
            const header = response.headers.get("retry-after");
            if (header !== null) {
              const delay = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - now();
              if (Number.isFinite(delay)) retryAfter = Math.max(retryAfter, now() + Math.min(86400000, Math.max(0, delay)));
            }
          }
          }
        } catch { result = "Transport failed or timed out"; }
        if (signal?.aborted) return;
        const completed = structuredClone(state);
        const entry = completed.deliveries.find(d => d.id === record.id)!;
        entry.result = result;
        entry.nextAttempt = retryAfter;
        if (result === "Delivered" || result === "Native refresh requested") entry.status = "delivered";
        else if (!retryable || entry.attempts >= 5) entry.status = "failed";
        await persist(completed);
      }
    }),
    test: async (id: string, signal?: AbortSignal) => {
      const d = state.destinations.find(d => d.id === id);
      if (!d) throw new Error("Unknown destination.");
      if (d.transport === "mobile") return "Mobile routing uses this environment's existing T3 Connect link and device permissions. Trigger a thread event to test; no synthetic push was sent.";
      const target = await dependencies.secret(`destination-${id}`);
      if (!target) throw new Error("Save an endpoint secret first.");
      const e: PluginNotification = { id: randomUUID(), sequence: 0, kind: "completion", threadId: "test", projectId: "test", provider: "test", title: "Synthetic notification test", occurredAt: new Date(now()).toISOString() };
      const configuration = endpointConfiguration(target);
      const req = request(d, e, configuration.url, e.id);
      try {
        const response = await send(req.url, { ...req.init, headers: { ...req.init.headers, ...configuration.headers }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
        await response.body?.cancel();
        return response.ok ? "Test delivered" : `Test failed: HTTP ${response.status}`;
      } catch { return "Test failed: transport error or timeout"; }
    },
  };
}
export type Engine = Awaited<ReturnType<typeof createEngine>>;
