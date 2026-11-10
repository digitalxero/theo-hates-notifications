import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { PluginView } from "@t3tools/plugin-sdk";
import plugin from "../dist/plugin.mjs";
const manifest = JSON.parse(await readFile(new URL("../t3-plugin.json", import.meta.url), "utf8"));
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(plugin.id, manifest.id);
assert.equal(plugin.version, pkg.version);
assert.equal(manifest.version, pkg.version);
const directory = await mkdtemp(join(tmpdir(), "notification-plugin-artifact-")),
  scope = await Effect.runPromise(Scope.make());
try {
  const contributions = await Effect.runPromise(
    plugin
      .activate({
        id: plugin.id,
        dataDirectory: directory,
        capabilities: ["settings-pages", "notification-journal", "notification-routing"],
        httpBasePath: "/unused",
        httpBaseUrl: Effect.succeed("http://unused.invalid"),
        notifications: { read: () => Effect.succeed({ cursor: 0, events: [] }) },
        runProcess: () =>
          Effect.die("No process should be needed for activation or the settings view"),
        secrets: {
          get: () => Effect.succeed(null),
          set: () => Effect.void,
          remove: () => Effect.void,
        },
      })
      .pipe(Effect.provideService(Scope.Scope, scope)),
  );
  assert.equal(contributions.views[0].location, "settings-page");
  Schema.decodeUnknownSync(PluginView)(await Effect.runPromise(contributions.views[0].read()));
  console.log("Bundled artifact activation and portable settings schema passed");
} finally {
  await Effect.runPromise(Scope.close(scope, Exit.void));
  await rm(directory, { recursive: true, force: true });
}
