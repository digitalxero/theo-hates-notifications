import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { PluginView } from "@t3tools/plugin-sdk";
import plugin from "../src/plugin.ts";

test("plugin owns a portable Extensions page, secrets are write-only, commands require settings permission and opt out of agent access", async () => {
  const dir=await mkdtemp(join(tmpdir(),"notification-plugin-"));
  const scope=await Effect.runPromise(Scope.make());
  const secrets=new Map<string,string>();
  try {
    const contributions=await Effect.runPromise(plugin.activate({
      id:plugin.id,dataDirectory:dir,capabilities:["notification-journal","notification-routing","native-notification-delivery","notification-targets","settings-pages"],
      environmentId:Effect.succeed("environment-1"),
      httpBasePath:"/unused",httpBaseUrl:Effect.succeed("http://unused.invalid"),
      notifications:{targets:Effect.succeed({projects:[],providers:[],truncated:false}),refreshNative:()=>Effect.void,read:()=>Effect.succeed({cursor:0,events:[]})},
      secrets:{get:key=>Effect.sync(()=>secrets.get(key)??null),set:(key,value)=>Effect.sync(()=>{secrets.set(key,value);}),remove:key=>Effect.sync(()=>{secrets.delete(key);})},
    }).pipe(Effect.provideService(Scope.Scope,scope)));
    assert.equal(contributions.views![0]!.location,"settings-page");
    for(const c of contributions.commands!) { assert.equal(c.permission,"settings:write");assert.equal(c.agent,false); }
    const run=async(id:string,input:Record<string,Schema.Json>)=>Effect.runPromise(contributions.commands!.find(c=>c.id===id)!.run(input));
    await run("configure",{id:"test",name:"Test",transport:"webhook",events:"completion,approval",projects:"",providers:"",enabled:true});
    await run("secret",{id:"test",endpoint:"https://fixture.invalid/hook?token=private-value"});
    assert.deepEqual(JSON.parse(secrets.get("destination-test")!),{url:"https://fixture.invalid/hook?token=private-value",headers:{}});
    await run("advanced-routing",{id:"test",events:"notice",projects:"",providers:""});
    await run("client-notice",{id:"notice-1",title:"A notice",description:"private-notice-body"});
    assert.equal(JSON.parse(await readFile(join(dir,"routing.json"),"utf8")).deliveries.length,0);
    await run("notice-routing",{enabled:true,details:false});
    await run("client-notice",{id:"notice-1",title:"A notice",description:"private-notice-body"});
    const routing=await readFile(join(dir,"routing.json"),"utf8");
    assert.equal(routing.includes("private-notice-body"),false);
    assert.equal(JSON.parse(routing).deliveries.length,1);
    await run("notice-routing",{enabled:false,details:false});
    const view=Schema.decodeUnknownSync(PluginView)(await Effect.runPromise(contributions.views![0]!.read()));
    assert.equal(JSON.stringify(view).includes("private-value"),false);
    await run("client-routing",{enabled:true,"in-app":true,mode:"sound",events:"completion",projects:"",providers:""});
    assert.deepEqual(await Effect.runPromise(contributions.notificationRoutes!()),[{id:"client",events:["completion"],projects:[],providers:[],inApp:true,mode:"sound"}]);
    await run("client-routing",{enabled:false});
    assert.deepEqual(await Effect.runPromise(contributions.notificationRoutes!()),[]);
    await run("remove",{id:"test"});assert.equal(secrets.size,0);
  } finally { await Effect.runPromise(Scope.close(scope,Exit.void));await rm(dir,{recursive:true,force:true}); }
});
