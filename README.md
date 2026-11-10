# theo-hates-notifications

An external T3 Code plugin for explicit notification routing. Destinations: Slack incoming webhooks, ntfy topics, generic JSON webhooks, Discord webhooks and Gotify message endpoints. Configuration and delivery history live on the owning environment. Complete endpoint URLs are stored through the host secret store.

Requires the shared plugin-host PoC branch `t3/create-plugin-system` in `djgilcrease/t3code`, including the `notification-journal`, `notification-routing` and `settings-pages` capabilities. Stock T3 Code does not support this plugin.

## Install and configure

Install `https://github.com/digitalxero/theo-hates-notifications` in **Settings → Plugins**. Open **Settings → Extensions → Theo Hates Notifications** on the environment that owns the work. Nothing routes until you configure a destination.

Give each destination a stable lowercase id and select the event names it should receive: `completion`, `input`, `approval`, `failure`, `usage-limit`, `guest-request`. Empty project/provider lists mean all; otherwise they match exact environment-local ids. Provider filters use provider instance ids, so separate accounts can have separate routes. Each environment owns its configuration; configuring one environment does not change another.

Save the full endpoint URL using the write-only endpoint form. Slack and Discord use incoming webhook URLs; ntfy uses the topic URL; Gotify uses its `/message?token=...` URL. Generic webhooks accept a JSON object containing `id` and `event`, with `Idempotency-Key` in the headers. Endpoint URLs may contain credentials, so do not paste them into route names or regular text fields. HTTPS is recommended; HTTP supports private services and local test endpoints.

**Send test** sends synthetic data to the selected endpoint. Destination errors show a status code or a generic transport error; response bodies and endpoint secrets are never included in history. Retryable responses (408, 429 and server errors) and transport failures use bounded exponential retry, at most five attempts. Other HTTP failures stop immediately. **Retry** explicitly queues a failed delivery again. Pausing a destination retains its queue; removing it discards pending deliveries and removes its endpoint secret.

## Client routing and coexistence

Builtin notifications and settings continue working. Installation does not change them. External destinations are additional channels. Explicit client routing can replace the web/desktop notification preferences for selected events, projects and provider instances. Turn client routing off to restore builtin preferences. Multiple matching plugins fall back to builtin preferences rather than competing for ownership.

Client routing reuses T3's existing in-app toast, native/browser notification, sound, badge and navigation behavior, including focus, active-thread and hidden-thread suppression. Grant system notification permission from builtin notification settings before selecting a system-alert mode. Browser sound still needs a user gesture. System alerts require a supported secure browser context or the desktop app, and T3 must be open for client delivery.

External destinations do not inherit a browser's focus or hidden-tag state: they run on the environment even while clients are disconnected. Use explicit route filters to control their scope. They never start an agent turn or process responses as agent input.

## Delivery guarantees

The host journals committed notification intents. The plugin persists its journal cursor and destination queue together before delivery. On first installation it starts at the journal tail, avoiding a historical flood. Configuration changes affect new events; queued deliveries retain the route snapshot. Requests interrupted after remote acceptance may be delivered again. Generic receivers should deduplicate by delivery id. This is at-least-once delivery, not an exactly-once promise for services that ignore idempotency keys.

## Current coverage limits

The implementation and parity audit are in progress. Mobile push, iOS/Android live activities, operational UI toasts/dialogs, remote delegated-child aggregation and externally actionable deep links are not yet replacement-capable. Existing builtin paths remain in use. Do not treat this development build as full notification parity or as a published release.

## Development

Use Node 24 or newer, `pnpm install --frozen-lockfile` and `task verify`. Tests send only to local fake servers. `dist/plugin.mjs` is the prebuilt installable bundle; installation runs no package scripts. The vendored SDK is the public plugin contract and imports no T3 internals. JS plugins are trusted same-user code running in supervised processes with crash isolation, not hostile-code sandboxes.

MIT. See LICENSE and the SDK attribution in `vendor/plugin-sdk`.
