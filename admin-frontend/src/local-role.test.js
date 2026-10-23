import test from "node:test";
import assert from "node:assert/strict";
import {localRoleEnabled, localRoleHeaders, setLocalRole} from "./local-role.js";
test("local role switching is gated by debug mode and both loopback hosts", () => {
 const config={localDebugAdmin:true,apiBase:"http://localhost:3001"};
 assert.equal(localRoleEnabled(config,"127.0.0.1"),true);
 assert.equal(localRoleEnabled(config,"dashboard.example.org"),false);
 assert.equal(localRoleEnabled({...config,localDebugAdmin:false},"localhost"),false);
 assert.equal(localRoleEnabled({...config,apiBase:"https://api.example.org"},"localhost"),false);
});
test("tab role selects matching manager identity and restores supervisor", () => {
 globalThis.location={hostname:"localhost"};
 const values=new Map();
 globalThis.sessionStorage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
 const config={localDebugAdmin:true,apiBase:"http://localhost:3001"};
 assert.equal(localRoleHeaders(config)["x-debug-groups"],"compliance-supervisor");
 setLocalRole("manager");
 assert.equal(localRoleHeaders(config)["x-debug-groups"],"compliance-manager");
 assert.equal(localRoleHeaders(config)["x-debug-email"],"maya.manager@example.org");
 assert.equal(localRoleHeaders(config)["x-debug-sub"],"maya.manager@example.org");
 assert.deepEqual(localRoleHeaders({...config,localDebugAdmin:false}),{});
 setLocalRole("supervisor");
 assert.equal(localRoleHeaders(config)["x-debug-sub"],"local-admin");
});
