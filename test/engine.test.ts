import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { PluginNotification } from "@t3tools/plugin-sdk";
import { createEngine, destination, matches, request, type Destination } from "../src/engine.ts";
const route: Destination = { id: "test", name: "Test", transport: "webhook", enabled: true, events: ["completion","approval"], projects: [], providers: [] };
const event: PluginNotification = { id: "event-1", sequence: 1, kind: "completion", threadId: "thread-1", projectId: "project-1", provider: "codex", title: "Build finished", occurredAt: "2026-11-10T00:00:00Z" };

test("route filters require opt-in and intersect event, provider and project", () => {
  assert.equal(matches(route,event), true);
  for (const change of [{ enabled:false }, { events:["input"] }, { projects:["other"] }, { providers:["claude"] }]) assert.equal(matches({ ...route,...change },event),false);
  assert.throws(() => destination({ ...route, events: [] }));
  assert.throws(() => destination({ ...route, id: "../../secret" }));
  assert.throws(() => destination({ ...route, events: ["unknown"] }));
});
test("destination wire formats exclude mentions and keep generic webhook identity", () => {
  for (const transport of ["slack","ntfy","webhook","discord","gotify"] as const) {
    const req = request({ ...route,transport },event,"http://127.0.0.1/fixture","delivery-1");
    assert.equal(req.init.redirect,"error");
    assert.equal((req.init.headers as Record<string,string>)["Idempotency-Key"],"delivery-1");
    if (transport === "webhook") assert.deepEqual(JSON.parse(String(req.init.body)),{ id:"delivery-1",event });
    if (transport === "ntfy") assert.equal(req.init.body,"completion: Build finished");
    if (transport === "discord") assert.deepEqual(JSON.parse(String(req.init.body)).allowed_mentions,{ parse:[] });
  }
  assert.throws(() => request(route,event,"file:///etc/passwd","id"));
});
test("real fake endpoints receive Slack, ntfy and webhook requests, secrets stay out of state, restart deduplicates", async () => {
  const dir = await mkdtemp(join(tmpdir(),"notification-routing-"));
  const received: { path:string; body:string; key:string|undefined }[] = [];
  const server = createServer(async (req,res) => {
    let body=""; for await (const chunk of req) body+=chunk;
    received.push({ path:req.url!,body,key:req.headers["idempotency-key"] as string|undefined });
    res.writeHead(204).end();
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  const port = (server.address() as { port:number }).port;
  const secret = async (key:string) => `http://127.0.0.1:${port}/${key}?token=secret-value`;
  try {
    let engine=await createEngine(dir,{ secret });
    for (const transport of ["slack","ntfy","webhook"] as const) await engine.configure({ ...route,id:transport,transport });
    await engine.ingest({ cursor:0,events:[] });
    await engine.ingest({ cursor:1,events:[event] });
    await engine.drain(); await engine.drain(); await engine.drain();
    assert.equal(received.length,3);
    assert.equal(engine.state().deliveries.filter(d=>d.status==="delivered").length,3);
    assert.equal((await readFile(join(dir,"routing.json"),"utf8")).includes("secret-value"),false);
    engine=await createEngine(dir,{ secret });
    await engine.ingest({ cursor:1,events:[event] });
    await engine.drain();
    assert.equal(received.length,3);
  } finally { await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())); await rm(dir,{recursive:true,force:true}); }
});
test("failed destination cannot block another route; retries, pause, restart and removal preserve explicit state", async () => {
  const dir=await mkdtemp(join(tmpdir(),"notification-failure-"));
  let clock=0, calls=0;
  const deps={ now:()=>clock, secret:async()=>"http://127.0.0.1/fixture", fetch:(async()=>{calls++;return new Response(null,{status:calls===1?503:204});}) as typeof fetch };
  try {
    let engine=await createEngine(dir,deps);
    await engine.configure(route);
    await engine.configure({...route,id:"other"});
    await engine.ingest({cursor:1,events:[event]});
    await engine.drain(); await engine.drain();
    assert.deepEqual(engine.state().deliveries.map(d=>d.status),["pending","delivered"]);
    await engine.configure({...route,enabled:false}); clock=100000;
    engine=await createEngine(dir,deps); await engine.drain(); assert.equal(calls,2);
    await engine.configure(route); await engine.drain(); assert.equal(calls,3);
    await engine.ingest({cursor:2,events:[{...event,id:"event-2",sequence:2}]});
    await engine.remove("test");
    assert.equal(engine.state().deliveries.find(d=>d.event.id==="event-2"&&d.destination.id==="test")?.status,"discarded");
    await assert.rejects(engine.ingest({cursor:1,events:[]}));
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test("permanent HTTP failure stops and explicit retry resets bounded attempts", async () => {
  const dir=await mkdtemp(join(tmpdir(),"notification-retry-"));
  try {
    const engine=await createEngine(dir,{secret:async()=>"https://fixture.invalid",fetch:(async()=>new Response(null,{status:401})) as typeof fetch});
    await engine.configure(route); await engine.ingest({cursor:1,events:[event]}); await engine.drain();
    const d=engine.state().deliveries[0]!; assert.equal(d.status,"failed"); assert.equal(d.result,"HTTP 401");
    await engine.retry(d.id); assert.equal(engine.state().deliveries[0]!.attempts,0);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
