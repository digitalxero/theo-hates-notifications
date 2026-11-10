import * as Schema from "effect/Schema";
import { PluginNotification, PluginNotificationRoutes, PluginError, type PluginNotificationTargets, type PluginContext, type PluginInput, type PluginView, type T3Plugin } from "@t3tools/plugin-sdk";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import { createEngine, kinds, defaultKinds, transports, endpointConfiguration, type Engine } from "./engine.ts";

const call = <A>(operation: string, run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new PluginError({ operation, cause }) });
function view(engine: Engine, failure: string | null, targets: PluginNotificationTargets, lastTest: string): PluginView {
  const state = engine.state();
  return {
    title: "Theo Hates Notifications",
    blocks: [
      { id: "intro", kind: "text", text: "Choose where alerts go. Builtin notifications keep working until you explicitly configure client routing. Endpoint URLs stay in this environment's secrets." },
      { id: "status", kind: "text", text: failure ?? `${state.deliveries.filter(d => d.status === "pending").length} queued, ${state.deliveries.filter(d => d.status === "failed").length} failed. Delivery retries up to five times; failed rows can be retried manually.${targets.truncated ? " Some filter choices are omitted; use Advanced routing for other IDs." : ""}` },
      { id: "test-result", kind: "text", text: lastTest },
      { id: "destinations", kind: "table", columns: ["Id", "Name", "Transport", "Events", "Projects", "Providers", "Enabled"], rows: state.destinations.map(d => ({ id: d.id, cells: [d.id,d.name,d.transport,d.events.join(", "),d.projects.map(id => targets.projects.find(p => p.id === id)?.label ?? id).join(", ") || "All",d.providers.map(id => targets.providers.find(p => p.id === id)?.label ?? id).join(", ") || "All",String(d.enabled)], actions: [
        { id: "test", label: "Send test", command: "test", input: { id: d.id } },
        { id: "toggle", label: d.enabled ? "Pause" : "Resume", command: "configure", input: { ...d, enabled: !d.enabled } },
        { id: "remove", label: "Remove", command: "remove", input: { id: d.id } },
      ] })) },
      { id: "configure", kind: "form", label: "Save destination and routing", command: "configure", input: {}, fields: [
        { name: "id", label: "Stable id (lowercase letters, digits and hyphens)", kind: "text", required: true },
        { name: "name", label: "Display name", kind: "text", required: true },
        { name: "transport", label: "Destination", kind: "select", value: "webhook", options: transports.map(value => ({ label: value, value })) },
        { name: "events", label: "Events", kind: "select", value: defaultKinds.join(","), options: [
          { label: "Thread alerts and reviews", value: defaultKinds.join(",") },
          { label: "Needs attention", value: "input,approval,failure,usage-limit,guest-request" },
          { label: "Completions", value: "completion" },
          { label: "Review guides", value: "review-ready,review-failure" },
          { label: "Client notices", value: "notice" },
          { label: "Mobile alerts and live activity", value: "completion,input,approval,failure,usage-limit,guest-request,activity,clear" },
          { label: "All notification types", value: kinds.join(",") },
        ] },
        { name: "projects", label: "Project", kind: "select", value: "", options: [{ label: "All projects", value: "" }, ...targets.projects.map(p => ({ label: p.label, value: p.id }))] },
        { name: "providers", label: "Provider / account", kind: "select", value: "", options: [{ label: "All providers", value: "" }, ...targets.providers.map(p => ({ label: p.label, value: p.id }))] },
        { name: "enabled", label: "Enable this route", kind: "boolean", value: true },
      ] },
      { id: "mobile", kind: "text", text: "Mobile destinations use T3's native T3 Connect delivery adapter, not an endpoint secret. Existing link/device preferences, push permissions, focus suppression, sounds, grouping, expiry and live activities remain authoritative. Host dispatch is not proof that a device displayed a notification." },
      { id: "secret", kind: "form", label: "Save endpoint secret", command: "secret", input: {}, fields: [
        { name: "id", label: "Destination id", kind: "text", required: true },
        { name: "endpoint", label: "Full endpoint URL (write only)", kind: "password", required: true },
        { name: "headers", label: 'HTTP headers as JSON, such as {"Authorization":"Bearer ..."} (optional, write only)', kind: "password" },
      ] },
      { id: "deliveries", kind: "table", columns: ["Destination", "Event", "Thread", "Status", "Attempts", "Result"], rows: state.deliveries.slice(-100).reverse().map((d,i) => ({ id: String(i), cells: [d.destination.name,d.event.kind,d.event.title,d.status,String(d.attempts),d.result ?? "Queued"], actions: d.status === "failed" ? [{ id: "retry", label: "Retry", command: "retry", input: { id: d.id } }] : [] })) },
      { id: "notice-routing", kind: "form", label: "Route client notices to this environment", command: "notice-routing", input: {}, fields: [
        { name: "enabled", label: "Forward client notices (destination must also include the notice event)", kind: "boolean", value: state.noticesEnabled },
        { name: "details", label: "Include notice descriptions, which may contain private project or error text", kind: "boolean", value: state.noticeDetails },
      ] },
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
      { id: "advanced-routing", kind: "form", label: "Advanced routing for an existing destination", command: "advanced-routing", input: {}, fields: [
        { name: "id", label: "Destination id", kind: "text", required: true },
        { name: "events", label: "Event names (comma separated)", kind: "text", value: defaultKinds.join(",") },
        { name: "projects", label: "Project ids (comma separated; empty means all)", kind: "text", value: "" },
        { name: "providers", label: "Provider instance ids (comma separated; empty means all)", kind: "text", value: "" },
      ] },
      { id: "limits", kind: "text", text: "Web/desktop client routing reuses the existing sound, badge, native alert and focus/tag behavior. Mobile destinations refresh the existing native adapter; builtin delivery remains active and deduplicates the same committed state. Client notice forwarding is opt-in; interactive controls retain their local actions. Native iOS, relay push and all platform behavior require separate verification. Route filters use exact project and provider instance ids on the owning environment. Pausing retains queued deliveries; removing discards pending deliveries. Removal of the plugin deletes its local configuration according to host lifecycle policy." },
    ],
  };
}
const list = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : String(value ?? "").split(",").map(s => s.trim()).filter(Boolean);
export default {
  apiVersion: 1,
  id: "theo-hates-notifications",
  name: "theo-hates-notifications",
  version: "0.1.2",
  description: "Explicit notification routing to Slack, ntfy, webhooks, Discord and Gotify.",
  activate: (context: PluginContext) => Effect.gen(function* () {
    if (!["notification-journal", "notification-routing", "native-notification-delivery", "notification-targets", "settings-pages"].every(capability => context.capabilities?.includes(capability)) || !context.notifications) return yield* new PluginError({ operation: "notification-host-required", cause: null });
    const notifications = context.notifications;
    const changes = yield* PubSub.unbounded<void>();
    const environmentId = context.environmentId ? yield* context.environmentId : undefined;
    const engine = yield* call("activate", () => createEngine(context.dataDirectory, { environmentId, native: (threadId, signal) => Effect.runPromise(notifications.refreshNative(threadId), { signal }), secret: key => Effect.runPromise(context.secrets.get(key)) }));
    if (engine.state().cursor === null) {
      const baseline = yield* notifications.read({ after: null });
      yield* call("baseline", () => engine.ingest(baseline));
    }
    let failure: string | null = null;
    let lastTest = "Send test checks one destination immediately. Test results appear here; tests are not automatically retried.";
    const tick = Effect.gen(function* () {
      const previous = engine.state();
      const batch = yield* notifications.read({ after: engine.state().cursor });
      yield* call("ingest", () => engine.ingest(batch)).pipe(Effect.catch(error =>
        call("deliver", signal => engine.drain(signal)).pipe(Effect.andThen(Effect.fail(error))),
      ));
      yield* call("deliver", signal => engine.drain(signal));
      failure = null;
      if (batch.events.length || JSON.stringify(previous.deliveries) !== JSON.stringify(engine.state().deliveries)) yield* PubSub.publish(changes, undefined);
    }).pipe(Effect.catch(() => Effect.sync(() => { failure = "Notification processing failed. The durable cursor and delivery queue are retained; processing will retry."; })));
    yield* tick.pipe(Effect.repeat(Schedule.spaced("5 seconds")), Effect.forkScoped);
    const command = (id: string, title: string, run: (input: PluginInput) => Effect.Effect<string, PluginError>) => ({ id, title, description: title, permission: "settings:write" as const, agent: false, run: (input: PluginInput) => run(input).pipe(Effect.tap(() => PubSub.publish(changes, undefined))) });
    return {
      changes: Stream.fromPubSub(changes),
      notificationRoutes: () => Effect.sync(() => {
        const state = engine.state();
        if (!state.noticesEnabled) return state.clientRoutes;
        const forward = { forwardCommand: "client-notice", includeDescription: state.noticeDetails };
        const clientKinds = ["notice", "review-ready", "review-failure"] as const;
        const routes = state.clientRoutes.map(route => route.events.some(kind => clientKinds.includes(kind as typeof clientKinds[number])) ? { ...route, ...forward } : route);
        for (const kind of clientKinds) {
          if (!routes.some(route => route.events.includes(kind))) routes.push({ id: kind, events: [kind], projects: [], providers: [], inApp: true, mode: kind === "notice" ? "off" : "inherit", ...forward });
        }
        return routes;
      }),
      views: [{ id: "settings", title: "Theo Hates Notifications", location: "settings-page" as const, permission: "settings:write" as const, read: () => notifications.targets.pipe(Effect.map(targets => view(engine, failure, targets, lastTest))) }],
      commands: [
        command("notice-routing", "Configure explicit notice forwarding", input => call("notice-routing", async () => { await engine.configureNotices(input.enabled === true, input.details === true); return "Notice forwarding saved. Interactive and progress notices retain their in-app actions."; })),
        command("client-notice", "Queue a client-origin notice", input => call("client-notice", async () => {
          const state = engine.state();
          if (!state.noticesEnabled) return "Notice forwarding is disabled.";
          const event = Schema.decodeUnknownSync(PluginNotification)({ id: String(input.id), sequence: -1, kind: typeof input.kind === "string" && ["notice", "review-ready", "review-failure"].includes(input.kind) ? input.kind : "notice", threadId: "client", projectId: typeof input.projectId === "string" ? input.projectId : "client", provider: typeof input.provider === "string" ? input.provider : "client", title: String(input.title), occurredAt: new Date().toISOString(),
            ...(state.noticeDetails && typeof input.description === "string" ? { description: input.description } : {}),
            ...(typeof input.path === "string" ? { path: input.path } : {}),
          });
          await engine.enqueueNotice(event);
          return "Notice queued.";
        })),
        command("client-url", "Save client URL for actionable links", input => call("client-url", async () => { await engine.setAppUrl(String(input.url)); return "Client URL saved. The receiving browser must already be paired with the environment."; })),
        command("client-routing", "Save explicit client notification routing", input => call("client-routing", async () => {
          const routes = Schema.decodeUnknownSync(PluginNotificationRoutes)(input.enabled === true ? [{ id: "client", events: list(input.events), projects: list(input.projects), providers: list(input.providers), inApp: input["in-app"] === true, mode: input.mode }] : []);
          await engine.setClientRoutes(routes);
          return "Client routing saved. Existing device permission and focus rules still apply.";
        })),
        command("advanced-routing", "Update advanced route filters", input => call("advanced-routing", async () => {
          const current = engine.state().destinations.find(d => d.id === input.id);
          if (!current) throw new Error("Unknown destination.");
          await engine.configure({ ...current, events: list(input.events), projects: list(input.projects), providers: list(input.providers) });
          return "Route filters updated.";
        })),
        command("configure", "Save destination routing", input => call("configure", async () => { await engine.configure({ ...input, events: list(input.events), projects: list(input.projects), providers: list(input.providers) }); return "Destination saved. Save its endpoint secret before sending a test."; })),
        command("secret", "Save destination endpoint secret", input => Effect.gen(function* () {
          const id = String(input.id);
          if (!engine.state().destinations.some(d => d.id === id)) return yield* new PluginError({ operation: "unknown-destination", cause: null });
          const value = yield* call("endpoint", async () => {
            try {
              return endpointConfiguration(JSON.stringify({ url: String(input.endpoint), headers: typeof input.headers === "string" && input.headers.trim() ? JSON.parse(input.headers) : {} }));
            } catch {
              throw new Error("Enter a valid HTTP(S) endpoint and a JSON object of headers.");
            }
          });
          yield* context.secrets.set(`destination-${id}`, JSON.stringify(value));
          return "Endpoint saved. The secret is never displayed.";
        })),
        command("test", "Send a synthetic destination test", input => call("test", async signal => {
          const id = String(input.id);
          const result = await engine.test(id, signal);
          lastTest = `${engine.state().destinations.find(d => d.id === id)?.name ?? "Destination"}: ${result}`;
          return result;
        })),
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
