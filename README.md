# theo-hates-notifications

Route T3 Code alerts to Slack incoming webhooks, ntfy, JSON webhooks, Discord, Gotify, in-app toasts, system notifications, sound, and T3's existing mobile delivery adapter. Each environment owns its routing, queue, and secrets.

Requires the shared [plugin-host PoC](https://github.com/djgilcrease/t3code/tree/t3/create-plugin-system), including `notification-journal`, `notification-routing`, `notification-targets`, `native-notification-delivery`, and `settings-pages`. Use host commit `fbbbb2b7266732c9d1ab94f4a45422be2458f642` or a compatible descendant. Stock T3 Code cannot install this plugin. The release notes pin the verified host commit and include a source/verification parity inventory.

## Install and configure

Install `https://github.com/digitalxero/theo-hates-notifications` in **Settings → Plugins**. Open **Settings → Extensions → Theo Hates Notifications** on the environment that owns the work. Installation changes no builtin notification setting and creates no destination.

Add a destination, choose events, and optionally filter by project and provider/account. Empty filters mean all; advanced routing accepts several exact environment-local IDs. Different environments have independent configuration. Events cover completion, input, approval, failure, usage limits, guest requests, activity/clear updates, review-guide results, and opted-in client notices.

For HTTP destinations, save the full endpoint URL using the write-only secret form. Slack and Discord use incoming webhook URLs; ntfy uses its topic URL; Gotify uses `/message?token=...`. Optional HTTP headers are a JSON object, such as `{"Authorization":"Bearer ..."}`. URLs and headers stay in host-owned secrets, outside route configuration and delivery history. HTTP supports private services and local fixtures; use HTTPS for internet destinations.

**Send test** sends synthetic data to that endpoint. Generic webhooks receive `{id,event,url?}` and an `Idempotency-Key` header. Destination failures show a status code or generic transport error, without response bodies or credentials. Transport failures, 408, 429 and server errors retry up to five attempts with exponential backoff and bounded Retry-After support. Other HTTP failures stop immediately. **Retry** explicitly queues a failed row again. **Pause** retains queued deliveries; **Remove** discards pending deliveries and removes its endpoint secret.

A mobile destination refreshes the committed source thread through T3's existing authenticated relay adapter. Configure T3 Connect, device registration, notification permissions, and live-activity preferences in the existing mobile settings. Its test button explains these requirements and sends no synthetic push. “Native refresh requested” means host dispatch, not device receipt.

## Coexistence and client routing

External destinations add channels. Builtin delivery continues. Explicit client routing can override web/desktop preferences for matching events, projects and accounts, using the existing in-app, native/browser, sound, badge, focus, hidden-thread and navigation behavior. Turn it off, disable or remove the plugin to restore builtin preferences. Conflicting matching owners fall back to builtin presentation. System alerts still require device permission and sound still requires browser audio consent.

Client notices and review-guide results originate in an open client. Forwarding them to HTTP destinations is a separate opt-in, with descriptions excluded by default because they may contain private error/project text. Choose one connected environment to own notices; ambiguous ownership is shown in Settings. Unknown-source notices match only unfiltered routes. Interactive/progress notices and dialogs keep their local actions. Android/iOS local notice presentation also respects OS permission; it does not replace relay-based thread alerts.

Mobile destinations reuse builtin relay deduplication, grouping, sounds, foreground suppression, expiry, and live-activity handling. They do not create a second native notification for the same committed state. Builtin relay publication stays active in this PoC. A future maintainer can move routing ownership while retaining those generic native adapters; this release performs no migration.

External destinations run while clients are disconnected and do not inherit a browser's focus or hidden-tag state. Links open the configured T3 web client; the recipient must already be paired. Review-guide links keep the guide action. No destination response is treated as agent input or starts a paid turn.

## Delivery and limits

The host journals notification intents with the orchestration commit. The plugin atomically saves its cursor and per-destination queue before delivery. First activation starts at the journal tail to avoid a historical flood. Queued entries keep their route snapshot. Disable/update preserves configuration and secrets; plugin removal deletes its environment-owned state and credentials.

An interrupted HTTP request can have an uncertain remote outcome. Delivery is at least once; receivers should deduplicate by delivery ID. Services that ignore idempotency keys can duplicate a request after a crash. The queue has count and byte limits; when full it retains the journal cursor and continues draining. History is bounded. Normal processing checks every five seconds and handles one delivery per tick, so this is intended for modest notification volume.

The release parity inventory distinguishes implemented contracts, source-preserved behavior, runtime evidence and unverified platforms. Native relay push, iOS ActivityKit, macOS/Windows OS presentation, and every provider-specific notification scenario are not all runtime-verified. Accessibility announcements, synchronous confirm/prompt controls, haptics and SnapShot capture sounds remain attached to their existing host interactions. They are inventoried explicitly rather than silently exported as repeated alerts.

## Development

Use Node 24.10 or newer, `pnpm install --frozen-lockfile`, and `task verify`. Tests use fake endpoints. `dist/plugin.mjs` and `t3-plugin.json` install without running package scripts. Taskfile release helpers pin svu and chglog. The vendored SDK is the public plugin contract; the plugin imports no T3 internals. JS plugins are trusted same-user code in supervised processes with crash isolation, not hostile-code sandboxes.

MIT. See LICENSE and `vendor/plugin-sdk` attribution and provenance.
