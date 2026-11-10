import * as Schema from "effect/Schema";
import { PluginNotificationRoutes, PluginError, type PluginContext, type PluginInput, type PluginView, type T3Plugin } from "@t3tools/plugin-sdk";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import { createEngine, kinds, transports, endpoint, type Engine } from "./engine.ts";

const call = <A>(operation: string, run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new PluginError({ operation, cause }) });
function view(engine: Engine, failure: string | null): PluginView {
  const state = engine.state();
  return {
    title: "Theo Hates Notifications",
    blocks: [
      { id: "intro", kind: "text", text: "Route committed thread notifications from this environment to external destinations. Routing starts empty. Builtin device notifications and their preferences continue independently. Adding an external route does not enable or disable any builtin channel. Credentials and endpoint URLs are write-only host secrets. Tests send synthetic data to the selected destination." },
      { id: "status", kind: "text", text: failure ?? `Listening. Journal cursor: ${state.cursor ?? "initializing"}. Up to five delivery attempts; failed deliveries need explicit retry. Endpoints may receive a duplicate after an interrupted request; webhooks receive an Idempotency-Key.` },
      { id: "destinations", kind: "table", columns: ["Id", "Name", "Transport", "Events", "Projects", "Providers", "Enabled"], rows: state.destinations.map(d => ({ id: d.id, cells: [d.id,d.name,d.transport,d.events.join(", "),d.projects.join(", ") || "All",d.providers.join(", ") || "All",String(d.enabled)], actions: [
        { id: "test", label: "Send test", command: "test", input: { id: d.id } },
        { id: "toggle", label: d.enabled ? "Pause" : "Resume", command: "configure", input: { ...d, enabled: !d.enabled } },
        { id: "remove", label: "Remove", command: "remove", input: { id: d.id } },
      ] })) },
      { id: "configure", kind: "form", label: "Save destination and routing", command: "configure", input: {}, fields: [
        { name: "id", label: "Stable id (lowercase letters, digits and hyphens)", kind: "text", required: true },
        { name: "name", label: "Display name", kind: "text", required: true },
        { name: "transport", label: "Destination", kind: "select", value: "webhook", options: transports.map(value => ({ label: value, value })) },
        { name: "events", label: "Event names, separated by commas", kind: "text", value: kinds.join(",") },
        { name: "projects", label: "Project ids, separated by commas (empty means all)", kind: "text", value: "" },
        { name: "providers", label: "Provider instance ids, separated by commas (empty means all)", kind: "text", value: "" },
        { name: "enabled", label: "Enable this route", kind: "boolean", value: true },
      ] },
      { id: "secret", kind: "form", label: "Save endpoint secret", command: "secret", input: {}, fields: [
        { name: "id", label: "Destination id", kind: "text", required: true },
        { name: "endpoint", label: "Full endpoint URL (Slack/Discord webhook, ntfy topic, Gotify message URL with token, or generic webhook)", kind: "password", required: true },
      ] },
      { id: "deliveries", kind: "table", columns: ["Destination", "Event", "Thread", "Status", "Attempts", "Result"], rows: state.deliveries.slice(-100).reverse().map((d,i) => ({ id: String(i), cells: [d.destination.name,d.event.kind,d.event.title,d.status,String(d.attempts),d.result ?? "Queued"], actions: d.status === "failed" ? [{ id: "retry", label: "Retry", command: "retry", input: { id: d.id } }] : [] })) },
      { id: "client-url", kind: "form", label: "Save client URL for notification links", command: "client-url", input: {}, fields: [
        { name: "url", label: "T3 web client origin or base path (no pairing token or query)", kind: "text", value: state.appUrl, required: true },
      ] },
      { id: "client-routing", kind: "form", label: "Replace this environment's web/desktop notification preferences for matching events", command: "client-routing", input: {}, fields: [
        { name: "enabled", label: "Use plugin client routing (off restores builtin preferences)", kind: "boolean", value: state.clientRoutes.length > 0 },
        { name: "in-app", label: "In-app toasts", kind: "boolean", value: state.clientRoutes[0]?.inApp ?? false },
        { name: "mode", label: "System alerts and sound (grant notification permission in builtin settings first)", kind: "select", value: state.clientRoutes[0]?.mode ?? "off", options: ["off","notifications","sound","notifications-and-sound"].map(value => ({ label:value,value })) },
        { name: "events", label: "Event names, separated by commas", kind: "text", value: state.clientRoutes[0]?.events.join(",") ?? kinds.join(",") },
        { name: "projects", label: "Project ids (empty means all)", kind: "text", value: state.clientRoutes[0]?.projects.join(",") ?? "" },
        { name: "providers", label: "Provider instance ids (empty means all)", kind: "text", value: state.clientRoutes[0]?.providers.join(",") ?? "" },
      ] },
      { id: "limits", kind: "text", text: "Web/desktop client routing reuses the existing sound, badge, native alert and focus/tag behavior. Mobile push, live activities and operational UI toasts remain builtin. This page does not claim replacement parity for those channels. Route filters use exact project and provider instance ids on the owning environment. Pausing retains queued deliveries; removing discards pending deliveries. Removal of the plugin deletes its local configuration according to host lifecycle policy." },
    ],
  };
}
const list = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : String(value ?? "").split(",").map(s => s.trim()).filter(Boolean);
export default {
  apiVersion: 1,
  id: "theo-hates-notifications",
  name: "Theo Hates Notifications",
  version: "0.1.0",
  description: "Explicit notification routing to Slack, ntfy, webhooks, Discord and Gotify.",
  activate: (context: PluginContext) => Effect.gen(function* () {
    if (!context.capabilities?.includes("notification-journal") || !context.notifications) return yield* new PluginError({ operation: "notification-host-required", cause: null });
    const notifications = context.notifications;
    const changes = yield* PubSub.unbounded<void>();
    const environmentId = context.environmentId ? yield* context.environmentId : undefined;
    const engine = yield* call("activate", () => createEngine(context.dataDirectory, { environmentId, secret: key => Effect.runPromise(context.secrets.get(key)) }));
    let failure: string | null = null;
    const tick = Effect.gen(function* () {
      const previous = engine.state();
      const batch = yield* notifications.read({ after: engine.state().cursor });
      yield* call("ingest", () => engine.ingest(batch));
      yield* call("deliver", signal => engine.drain(signal));
      failure = null;
      if (batch.events.length || JSON.stringify(previous.deliveries) !== JSON.stringify(engine.state().deliveries)) yield* PubSub.publish(changes, undefined);
    }).pipe(Effect.catch(() => Effect.sync(() => { failure = "Notification processing failed. The durable cursor and delivery queue are retained; processing will retry."; })));
    yield* tick.pipe(Effect.repeat(Schedule.spaced("5 seconds")), Effect.forkScoped);
    const command = (id: string, title: string, run: (input: PluginInput) => Effect.Effect<string, PluginError>) => ({ id, title, description: title, permission: "settings:write" as const, agent: false, run: (input: PluginInput) => run(input).pipe(Effect.tap(() => PubSub.publish(changes, undefined))) });
    return {
      changes: Stream.fromPubSub(changes),
      notificationRoutes: () => Effect.sync(() => engine.state().clientRoutes),
      views: [{ id: "settings", title: "Theo Hates Notifications", location: "settings-page" as const, permission: "settings:write" as const, read: () => Effect.sync(() => view(engine, failure)) }],
      commands: [
        command("client-url", "Save client URL for actionable links", input => call("client-url", async () => { await engine.setAppUrl(String(input.url)); return "Client URL saved. The receiving browser must already be paired with the environment."; })),
        command("client-routing", "Save explicit client notification routing", input => call("client-routing", async () => {
          const routes = Schema.decodeUnknownSync(PluginNotificationRoutes)(input.enabled === true ? [{ id: "client", events: list(input.events), projects: list(input.projects), providers: list(input.providers), inApp: input["in-app"] === true, mode: input.mode }] : []);
          await engine.setClientRoutes(routes);
          return "Client routing saved. Existing device permission and focus rules still apply.";
        })),
        command("configure", "Save destination routing", input => call("configure", async () => { await engine.configure({ ...input, events: list(input.events), projects: list(input.projects), providers: list(input.providers) }); return "Destination saved. Save its endpoint secret before sending a test."; })),
        command("secret", "Save destination endpoint secret", input => Effect.gen(function* () {
          const id = String(input.id);
          if (!engine.state().destinations.some(d => d.id === id)) return yield* new PluginError({ operation: "unknown-destination", cause: null });
          const value = yield* call("endpoint", async () => endpoint(String(input.endpoint)).href);
          yield* context.secrets.set(`destination-${id}`, value);
          return "Endpoint saved. The secret is never displayed.";
        })),
        command("test", "Send a synthetic destination test", input => call("test", signal => engine.test(String(input.id), signal))),
        command("retry", "Retry failed delivery", input => call("retry", async () => { await engine.retry(String(input.id)); return "Delivery queued."; })),
        command("remove", "Remove destination and discard pending deliveries", input => Effect.gen(function* () {
          const id = String(input.id);
          yield* call("remove", () => engine.remove(id));
          yield* context.secrets.remove(`destination-${id}`);
          return "Destination removed; pending deliveries discarded.";
        })),
      ],
    };
  }),
} satisfies T3Plugin;
