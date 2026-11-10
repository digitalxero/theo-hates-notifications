import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { PluginNotification } from "@t3tools/plugin-sdk";
import { createEngine, destination, endpointConfiguration, matches, request, type Destination } from "../src/engine.ts";
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
    assert.deepEqual(Object.fromEntries(engine.state().deliveries.map(d=>[d.destination.id,d.status])),{test:"pending",other:"delivered"});
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

test("mobile delivery refreshes the committed source thread through the host without HTTP, and distinguishes dispatch from device receipt", async () => {
  const dir=await mkdtemp(join(tmpdir(),"native-notification-"));
  const refreshed:string[]=[];
  try {
    const engine=await createEngine(dir,{secret:async()=>{throw new Error("Native delivery must not read an HTTP secret");},native:async id=>{refreshed.push(id);}});
    await engine.configure({...route,transport:"mobile",events:["completion","activity","clear"]});
    await engine.ingest({cursor:1,events:[{...event,sourceThreadId:"child",threadId:"parent"}]});
    await engine.drain();
    assert.deepEqual(refreshed,["child"]);
    assert.equal(engine.state().deliveries[0]!.result,"Native refresh requested");
    assert.match(await engine.test("test"),/no synthetic push was sent/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("paused head cannot starve another destination and Retry-After survives restart with a five-attempt ceiling", async () => {
  const dir=await mkdtemp(join(tmpdir(),"notification-backoff-"));
  let clock=0;
  const sent:string[]=[];
  const deps={now:()=>clock,secret:async(key:string)=>`http://fixture.invalid/${key}`,fetch:(async(url:string)=>{sent.push(String(url));return new Response(null,{status:429,headers:{"Retry-After":"60"}});}) as typeof fetch};
  try {
    let engine=await createEngine(dir,deps);
    await engine.configure(route); await engine.configure({...route,id:"second"});
    await engine.ingest({cursor:1,events:[event]});
    await engine.configure({...route,enabled:false});
    await engine.drain();
    assert.deepEqual(sent,["http://fixture.invalid/destination-second"]);
    assert.equal(engine.state().deliveries.find(d=>d.destination.id==="second")!.nextAttempt,60000);
    engine=await createEngine(dir,deps);
    clock=59999; await engine.drain(); assert.equal(sent.length,1);
    for(let attempt=2;attempt<=5;attempt++) { clock=(attempt-1)*60000; await engine.drain(); }
    assert.equal(sent.length,5);
    assert.equal(engine.state().deliveries.find(d=>d.destination.id==="second")!.status,"failed");
    clock=1000000; await engine.drain(); assert.equal(sent.length,5);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test("header credentials stay in the secret boundary, notice forwarding is explicit, and notices never advance the committed cursor", async () => {
  const dir=await mkdtemp(join(tmpdir(),"notification-private-"));
  const config=endpointConfiguration(JSON.stringify({url:"https://fixture.invalid/hook",headers:{Authorization:"Bearer private-value"}}));
  for(const headers of [{Host:"other.invalid"},{"Idempotency-Key":"override"},{Authorization:"bad\nheader"}]) assert.throws(()=>endpointConfiguration(JSON.stringify({url:config.url,headers})));
  let auth:string|undefined;
  try {
    const engine=await createEngine(dir,{environmentId:"env",secret:async()=>JSON.stringify(config),fetch:(async(_url,init)=>{auth=new Headers(init?.headers).get("authorization")??undefined;return new Response(null,{status:204});}) as typeof fetch});
    await engine.configure({...route,events:["notice"]});
    await engine.ingest({cursor:42,events:[]});
    const notice={...event,id:"client-notice",kind:"notice" as const,sequence:-1};
    await engine.enqueueNotice(notice); assert.equal(engine.state().deliveries.length,0);
    await engine.configureNotices(true,false);
    await engine.enqueueNotice(notice); await engine.enqueueNotice(notice);
    assert.equal(engine.state().deliveries.length,1); assert.equal(engine.state().cursor,42);
    await engine.drain(); assert.equal(auth,"Bearer private-value");
    assert.equal((await readFile(join(dir,"routing.json"),"utf8")).includes("private-value"),false);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("interrupted delivery reserves an attempt and reuses its durable id after restart", async () => {
  const dir=await mkdtemp(join(tmpdir(),"notification-interrupt-"));
  const controller=new AbortController();
  let clock=0;
  const keys:string[]=[];
  const deps={now:()=>clock,secret:async()=>"http://fixture.invalid",fetch:(async(_url,init)=>{keys.push(new Headers(init?.headers).get("Idempotency-Key")!);controller.abort();return new Response(null,{status:204});}) as typeof fetch};
  try {
    let engine=await createEngine(dir,deps);
    await engine.configure(route); await engine.ingest({cursor:1,events:[event]}); await engine.drain(controller.signal);
    assert.equal(engine.state().deliveries[0]!.attempts,1);assert.equal(engine.state().deliveries[0]!.status,"pending");
    clock=10000; engine=await createEngine(dir,{...deps,fetch:(async(_url,init)=>{keys.push(new Headers(init?.headers).get("Idempotency-Key")!);return new Response(null,{status:204});}) as typeof fetch});
    await engine.drain(); assert.equal(engine.state().deliveries[0]!.status,"delivered");assert.equal(engine.state().deliveries[0]!.attempts,2);assert.equal(keys[0],keys[1]);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
