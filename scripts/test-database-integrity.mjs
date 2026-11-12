import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, lstat, symlink, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir, platform, arch } from "node:os";

// Disposable local PostgreSQL, never a DATABASE_URL or a Supabase connection.
// Install the pinned test-only tools outside this project and set this directory
// when it differs. No production identities, secrets, requests or quota are used.
const toolsPath = process.env.LIFE_TRACKER_TEST_TOOLS || "/private/tmp/life-tracker-audit-tools-20261001/node_modules";
const exit = process.exit.bind(process); // Preserve a failing exit code despite embedded-postgres's exit hook.
const { default: EmbeddedPostgres } = await import("embedded-postgres").catch(error => {
  if(error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  return import(pathToFileURL(path.join(toolsPath, "embedded-postgres/dist/index.js")));
});
async function hydrateSafePackageLinks() {
  const spec=`@embedded-postgres/${platform()==="win32"?"windows":platform()}-${arch()}`;
  const binaries=await import(spec).catch(error=>{if(error.code!=="ERR_MODULE_NOT_FOUND")throw error;return import(pathToFileURL(path.join(toolsPath,spec,"dist/index.js")));});
  const native=await realpath(path.dirname(path.dirname(binaries.initdb)));
  let links=[];
  try { links=JSON.parse(await readFile(path.join(native,"pg-symlinks.json"),"utf8")); } catch(error) { if(error.code!=="ENOENT")throw error; }
  for(const {source,target} of links) {
    if(typeof source!=="string"||typeof target!=="string"||!source.startsWith("native/")||!target.startsWith("native/")||source.split(/[\\/]/).includes("..")||target.split(/[\\/]/).includes("..")) throw new Error("Unsafe native package symlink metadata");
    const from=path.resolve(native,source.slice(7)),to=path.resolve(native,target.slice(7));
    if(!from.startsWith(`${native}${path.sep}`)||!to.startsWith(`${native}${path.sep}`))throw new Error("Native link escaped package");
    const sourceReal=await realpath(from);
    if(!sourceReal.startsWith(`${native}${path.sep}`))throw new Error("Native source symlink escaped package");
    try { await lstat(to); } catch(error) { if(error.code!=="ENOENT")throw error; await symlink(path.relative(path.dirname(to),from),to); }
  }
}
const parent = await mkdtemp(path.join(tmpdir(), "life-tracker-db-acceptance-"));
const logs = [];
const cluster = new EmbeddedPostgres({ databaseDir: path.join(parent, "data"), port: 55432, user: "postgres", password: "local-disposable-test-only", persistent: false, createPostgresUser: false,
  initdbFlags: ["--set=shared_memory_type=mmap", "--set=dynamic_shared_memory_type=mmap"],
  postgresFlags: ["-c", "listen_addresses=127.0.0.1", "-c", `unix_socket_directories=${parent}`, "-c", "shared_memory_type=mmap", "-c", "dynamic_shared_memory_type=mmap"], onLog: message => logs.push(String(message)), onError: message => logs.push(String(message)) });
const clients = [];
async function client(role = "postgres", userId = "") {
  const value = cluster.getPgClient("postgres", "127.0.0.1"); await value.connect(); clients.push(value);
  await value.query("set timezone='UTC'"); // Never inherit a developer machine's Shanghai timezone.
  if (role !== "postgres") await value.query(`SET ROLE ${role}`);
  await value.query("SELECT set_config('request.jwt.claim.role',$1,false), set_config('request.jwt.claim.sub',$2,false)", [role, userId]);
  return value;
}
const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222", F = "33333333-3333-4333-8333-333333333333", O = "44444444-4444-4444-8444-444444444444";
const json = value => JSON.stringify(value);
const scalar = async (connection, sql, args = []) => (await connection.query(sql, args)).rows[0].value;
const save = (connection, table, payload, expected = null, requestId = randomUUID()) => scalar(connection, "select public.save_user_mutation($1,$2::jsonb,$3::timestamptz,$4::uuid) as value", [table, json(payload), expected, requestId]);
const rejectCode = (promise, code) => assert.rejects(promise, error => error.code === code);
let migrationCount = 0;
let failed = false;
try {
  await hydrateSafePackageLinks();
  await cluster.initialise(); await cluster.start();
  const admin = await client();
  await admin.query(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create schema storage; create schema extensions;
    create extension pgcrypto with schema extensions;
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now(), raw_user_meta_data jsonb default '{}'::jsonb);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role',true),'') $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text not null);
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1] $$;
    grant usage on schema auth, storage, extensions, public to anon,authenticated,service_role;
    grant execute on all functions in schema auth, storage, extensions to anon,authenticated,service_role;
    grant select,insert,update,delete on storage.objects to authenticated;
    grant all on all tables in schema auth, storage to service_role;
    alter default privileges in schema public grant all on tables to service_role;
    alter default privileges in schema public grant all on sequences to service_role;
  `);
  const migrations = (await readdir("supabase/migrations")).filter(name => name.endsWith(".sql")).sort();
  // Historical identity repair requires its Auth user to exist. Parameterize
  // only that configuration digest for a synthetic account, as required for
  // any fresh project; never create or assume a production owner identity.
  const bootstrapEmail="bootstrap-owner@example.invalid",bootstrapId=randomUUID();
  await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",[bootstrapId,bootstrapEmail]);
  const historicalOwnerHash="65a64dff94079533ab3aeecd6c5068f193532cf6f9c6c853bc76a0cdfef9df0c";
  const bootstrapHash=createHash("sha256").update(bootstrapEmail).digest("hex");
  let identityConfigurations=0;
  const legacyTripId=randomUUID(),legacyFlightId=randomUUID(),legacyStaleId=randomUUID(),legacyConfirmedId=randomUUID();
  for (const name of migrations) {
    try {
      const source=await readFile(path.join("supabase/migrations",name),"utf8");
      if(name==="20261111172418_audit_relations_and_periods.sql") await admin.query("insert into public.api_quota_buckets(bucket_key,service,quota_group,period_start,period_end,limit_value,used_value) values('aviation:global:2026-02','aviation','flight','2026-01-31T16:00:00Z','2026-02-27T16:00:00Z',100,18)");
      if(source.includes(historicalOwnerHash))identityConfigurations++;
      await admin.query(source.replaceAll(historicalOwnerHash,bootstrapHash)); migrationCount++;
      if(name==="20260715000000_release_1_4_1_owner_admin_and_quota.sql") {
        await admin.query("insert into public.trips(id,user_id,name,start_date,end_date,timezone) values($1,$2,'legacy trip','2026-09-29','2026-10-02','Asia/Tokyo')",[legacyTripId,bootstrapId]);
        const stop=(date,time,timezone,iata)=>({date,time,timezone,iata,airport:iata,terminal:""});
        const plan={airline:"ANA",flight_number:"NH105",departure:stop("2026-09-28","00:50","America/Los_Angeles","LAX"),arrival:stop("2026-09-29","05:00","Asia/Tokyo","HND")};
        const actual={flight_number:plan.flight_number,status:"landed",departure:{iata:"LAX",timezone:plan.departure.timezone,scheduled:{date:plan.departure.date,time:plan.departure.time}},arrival:{iata:"HND",timezone:plan.arrival.timezone,scheduled:{date:plan.arrival.date,time:plan.arrival.time}}};
        for(const [id,requestId,info] of [[legacyFlightId,legacyConfirmedId,actual],[legacyStaleId,randomUUID(),{...actual,flight_number:"NH999"}]]) await admin.query("insert into public.records(id,user_id,record_type,content,event_at,trip_id,plan_status,transport_type,transport_details,actual_info,actual_info_matched,actual_match_status,actual_match_request_id,actual_matched_at) values($1,$2,'trip','legacy flight','2026-09-28T07:50:00Z',$3,'completed','flight',$4::jsonb,$5::jsonb,true,'matched',$6,now())",[id,bootstrapId,legacyTripId,json(plan),json(info),requestId]);
        await admin.query("insert into public.daily_summaries(user_id,summary_date,content) values($1,'2026-09-29','old day one'),($1,'2026-09-30','old day two')",[bootstrapId]);
      }
    }
    catch (error) { throw new Error(`Migration ${name} failed: ${error.message}`, { cause: error }); }
  }
  assert.equal(identityConfigurations,2);
  for (const role of ["anon", "authenticated"]) {
    assert.equal(await scalar(admin, "select has_function_privilege($1, 'public.handle_new_user_profile()', 'execute') as value", [role]), false, `${role} cannot invoke the profile trigger function`);
  }
  const repairedBucket=await scalar(admin,"select to_jsonb(b) as value from public.api_quota_buckets b where bucket_key='aviation:global:2026-02'");
  assert.equal(new Date(repairedBucket.period_end).toISOString(),"2026-02-28T16:00:00.000Z");assert.equal(repairedBucket.used_value,18);assert.equal(repairedBucket.limit_value,100);
  assert.equal(await scalar(admin,"select tier as value from public.api_entitlements where user_id=$1",[bootstrapId]),"owner");
  const migrated=await scalar(admin,"select to_jsonb(r) as value from public.records r where id=$1",[legacyFlightId]);
  assert.equal(migrated.actual_info_matched,true);assert.equal(Number(migrated.flight_plan_version),1);assert.equal(Number(migrated.actual_match_plan_version),1);assert.equal(migrated.actual_confirmed_request_id,legacyConfirmedId);
  const staleMigrated=await scalar(admin,"select to_jsonb(r) as value from public.records r where id=$1",[legacyStaleId]);
  assert.equal(staleMigrated.actual_info_matched,false);assert.equal(staleMigrated.actual_info.flight_number,"NH999");assert.equal(staleMigrated.actual_confirmed_request_id,null);
  assert.equal(Number(await scalar(admin,"select count(distinct context_key) as value from public.daily_summaries where user_id=$1",[bootstrapId])),2,"Legacy Shanghai caches are retained under separate historical contexts");
  console.log("PASS: V1.4.1 legacy data upgrades without loss; only fully proven matched segment retains valid metadata, stale payload kept historical, old daily summaries isolated.");
  console.log(`PASS: ${migrationCount} complete migrations on disposable PostgreSQL ${await scalar(admin, "select current_setting('server_version') as value")}; only historical Owner identity digest configured for synthetic test user.`);
  await admin.query("insert into auth.users(id,email,email_confirmed_at) select id::uuid, 'test-'||left(id,8)||'@example.invalid', now() from unnest($1::text[]) id", [[A,B,F,O]]);
  assert.equal(await scalar(admin, "select exists(select 1 from public.profiles where user_id=$1) as value", [A]), true, "The auth trigger still creates a profile after execute privileges are revoked");
  await admin.query("update public.api_entitlements set tier=case user_id when $1::uuid then 'friend' when $2::uuid then 'owner' else tier end where user_id in($1::uuid,$2::uuid)", [F,O]);
  const a = await client("authenticated", A), b = await client("authenticated", B), service = await client("service_role");

  const id = randomUUID(), request = randomUUID(), payload = { id, user_id: A, record_type: "note", content: "initial", event_at: "2026-10-01T00:00:00Z" };
  const initial = await save(a, "records", payload, null, request);
  assert.equal(initial.ok, true); assert.equal(initial.row.content, "initial");
  assert.deepEqual(await save(a, "records", payload, null, request), initial, "Lost-response retries are idempotent");
  assert.equal(Number(await scalar(admin, "select count(*) as value from public.client_mutation_receipts where request_id=$1", [request])), 1);
  await rejectCode(save(a, "records", { ...payload, content: "reused UUID changed" }, null, request), "22023");
  await rejectCode(save(b, "records", payload), "42501");
  await rejectCode(save(b, "records", { ...payload, user_id: B }), "42501");
  await rejectCode(save(a, "api_entitlements", { user_id: A, tier: "owner" }), "42501");
  await rejectCode(save(a, "records", { ...payload, actual_info_matched: true }, initial.row.updated_at), "42501");
  assert.equal((await save(a, "records", { ...payload, content: "no version" })).code, "CONFLICT");
  const first = await save(a, "records", { ...payload, content: "device one" }, initial.row.updated_at);
  assert.equal(first.ok, true); assert.notEqual(first.row.updated_at, initial.row.updated_at);
  assert.equal((await save(a, "records", { ...payload, content: "stale device two" }, initial.row.updated_at)).code, "CONFLICT");
  assert.equal(await scalar(admin, "select content as value from public.records where id=$1", [id]), "device one");
  const concurrentA = await client("authenticated", A), concurrentB = await client("authenticated", A);
  const collision = await Promise.all([save(concurrentA, "records", { ...payload, content: "collision one" }, first.row.updated_at), save(concurrentB, "records", { ...payload, content: "collision two" }, first.row.updated_at)]);
  assert.equal(collision.filter(result => result.ok).length, 1); assert.equal(collision.filter(result => result.code === "CONFLICT").length, 1);
  assert.equal(Number(await scalar(b, "select count(*) as value from public.records where id=$1", [id])), 0, "RLS hides another user's records");
  const deletionRecord=randomUUID();
  const deletionCreated=await save(a,"records",{id:deletionRecord,user_id:A,record_type:"note",content:"delete test"});
  const deletionUpdated=await save(a,"records",{id:deletionRecord,user_id:A,record_type:"note",content:"newer"},deletionCreated.row.updated_at);
  assert.equal((await b.query("delete from public.records where id=$1 and user_id=$2 and updated_at=$3 returning id",[deletionRecord,A,deletionUpdated.row.updated_at])).rowCount,0,"A different account cannot delete the record");
  assert.equal((await a.query("delete from public.records where id=$1 and user_id=$2 and updated_at=$3 returning id",[deletionRecord,A,deletionCreated.row.updated_at])).rowCount,0,"Stale edits cannot delete the newer record");
  assert.equal((await a.query("delete from public.records where id=$1 and user_id=$2 and updated_at=$3 returning id",[deletionRecord,A,deletionUpdated.row.updated_at])).rowCount,1,"Owner can delete the exact current version");
  await rejectCode(b.query("insert into public.records(user_id,record_type,content) values($1,'note','cross owner')", [A]), "42501");
  await rejectCode(b.query("select public.consume_api_quota($1,null,'route',$2)", [B,randomUUID()]), "42501");
  await rejectCode(b.query("select * from public.client_mutation_receipts"), "42501");
  await rejectCode(b.query("select * from public.api_entitlements"), "42501");
  const imagePath=`${A}/${randomUUID()}`;
  await a.query("insert into storage.objects(bucket_id,name) values('record-images',$1)", [imagePath]);
  await rejectCode(b.query("insert into storage.objects(bucket_id,name) values('record-images',$1)", [`${A}/${randomUUID()}`]), "42501");
  assert.equal(Number(await scalar(b,"select count(*) as value from storage.objects where name=$1",[imagePath])),0,"Other accounts cannot access private record images");
  const photoExpense=await save(a,"records",{id:randomUUID(),user_id:A,record_type:"expense",content:"photo expense",amount:1,currency:"JPY",expense_category:"food",image_path:imagePath});
  assert.equal(photoExpense.ok,true,"An expense can reference a private image");
  await a.query("insert into storage.objects(bucket_id,name) values('avatars',$1)", [`${A}/test.png`]);
  await rejectCode(b.query("insert into storage.objects(bucket_id,name) values('avatars',$1)", [`${A}/other.png`]), "42501");
  assert.equal(Number(await scalar(b, "select count(*) as value from storage.objects where name=$1", [`${A}/test.png`])), 0);
  console.log("PASS: CAS create/update/conflict/idempotence/reused UUID, concurrent device writes, strict table/field ownership, account RLS and avatar path RLS.");

  // F03: changes to a parent cannot invalidate children; lock waits recheck
  // both race directions using actual independent PostgreSQL transactions.
  const tripOne=randomUUID(),tripTwo=randomUUID();
  for(const tid of [tripOne,tripTwo]) await save(a,"trips",{id:tid,user_id:A,name:tid,start_date:"2026-10-01",end_date:"2026-10-02",timezone:"UTC"});
  const planPayload=(pid)=>({id:pid,user_id:A,record_type:"trip",content:"parent",trip_id:tripOne,plan_status:"planned",event_at:"2026-10-01T00:00:00Z"});
  const parentId=randomUUID(),parentPayload=planPayload(parentId),parentSaved=await save(a,"records",parentPayload);
  await save(a,"records",{id:randomUUID(),user_id:A,record_type:"note",content:"actual",trip_id:tripOne,parent_plan_id:parentId,event_at:"2026-10-01T01:00:00Z"});
  await rejectCode(save(a,"records",{...parentPayload,trip_id:tripTwo},parentSaved.row.updated_at),"P0001");
  await rejectCode(save(a,"records",{...parentPayload,record_type:"note",plan_status:null},parentSaved.row.updated_at),"P0001");
  assert.equal(Number(await scalar(admin,"select count(*) as value from public.records c join public.records p on p.id=c.parent_plan_id where c.trip_id is distinct from p.trip_id or p.record_type<>'trip'")),0);
  const raceChild=await client("authenticated",A),raceParent=await client("authenticated",A);
  const childFirst=randomUUID(),childFirstPayload=planPayload(childFirst),childFirstSaved=await save(a,"records",childFirstPayload);
  await raceChild.query("begin");
  await save(raceChild,"records",{id:randomUUID(),user_id:A,record_type:"note",content:"race child",trip_id:tripOne,parent_plan_id:childFirst,event_at:"2026-10-01T01:00:00Z"});
  await raceParent.query("set application_name='audit-race'");
  const moveBlocked=save(raceParent,"records",{...childFirstPayload,trip_id:tripTwo},childFirstSaved.row.updated_at).then(value=>({value}),error=>({error}));
  const waitForLock=async()=>{for(let attempt=0;attempt<200;attempt++){if(Number(await scalar(admin,"select count(*) as value from pg_stat_activity where application_name='audit-race' and wait_event_type='Lock'")))return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error("Expected relation lock wait did not occur");};
  await waitForLock();await raceChild.query("commit");assert.equal((await moveBlocked).error?.code,"P0001");
  const parentFirst=randomUUID(),parentFirstPayload=planPayload(parentFirst),parentFirstSaved=await save(a,"records",parentFirstPayload);
  await raceParent.query("begin");await save(raceParent,"records",{...parentFirstPayload,trip_id:tripTwo},parentFirstSaved.row.updated_at);
  await raceChild.query("set application_name='audit-race'");
  const insertBlocked=save(raceChild,"records",{id:randomUUID(),user_id:A,record_type:"note",content:"stale child",trip_id:tripOne,parent_plan_id:parentFirst,event_at:"2026-10-01T01:00:00Z"}).then(value=>({value}),error=>({error}));
  await waitForLock();await raceParent.query("commit");assert.equal((await insertBlocked).error?.code,"P0001");
  console.log("PASS F03: reverse parent trip/type constraints and both child-insert/parent-move lock-wait races preserve relations.");

  // F06: execute the exact expressions used by admission, not a duplicated
  // formula; cover UTC/Shanghai sessions and long/short/leap/year boundaries.
  const quotaSource=await readFile("supabase/migrations/20261111172411_atomic_quota_admission.sql","utf8");
  const endExpression=quotaSource.match(/v_month_end := (.+);/)[1].replaceAll("now()","$1::timestamptz");
  for(const zone of ["UTC","Asia/Shanghai"]) {
    await service.query("select set_config('TimeZone',$1,false)",[zone]);
    for(const [input,expected] of [["2026-10-02T00:00:00Z","2026-10-31T16:00:00.000Z"],["2026-02-15T00:00:00Z","2026-02-28T16:00:00.000Z"],["2024-02-15T00:00:00Z","2024-02-29T16:00:00.000Z"],["2026-04-01T00:00:00Z","2026-04-30T16:00:00.000Z"],["2026-12-15T00:00:00Z","2026-12-31T16:00:00.000Z"]])assert.equal(new Date(await scalar(service,`select ${endExpression} as value`,[input])).toISOString(),expected);
  }
  await service.query("set timezone='UTC'");
  console.log("PASS F06: Shanghai month arithmetic is invariant to UTC/Shanghai database sessions; existing reset metadata corrected without changing counters.");

  // Real concurrent transactions, not a mock of the admission check.
  const workers = await Promise.all(Array.from({ length: 20 }, () => client("service_role")));
  const quota = (connection, user, feature = "route", req = randomUUID()) => scalar(connection, "select public.consume_api_quota($1::uuid,null,$2,$3::uuid) as value", [user,feature,req]);
  const burst = await Promise.all(workers.map(connection => quota(connection, F)));
  assert.equal(burst.filter(value => value.allowed).length, 10, "20 simultaneous non-owner requests admit exactly ten");
  const denied = burst.filter(value => !value.allowed);
  assert.equal(denied.every(value => value.code === "COOLDOWN"), true);
  assert.equal(Number(await scalar(admin, "select count(*) as value from public.api_usage_events where user_id=$1", [F])), 10);
  const retryDates = denied.map(value => Date.parse(value.retry_at));
  assert.ok(Math.max(...retryDates)-Math.min(...retryDates) < 2000, "Concurrent denials share one cooldown window");
  assert.ok(retryDates[0] > Date.now()+290000 && retryDates[0] < Date.now()+310000);
  assert.equal((await quota(service, B)).allowed, true, "Another user does not inherit cooldown");
  const ownerBurst = await Promise.all(workers.map(connection => quota(connection, O)));
  assert.equal(ownerBurst.every(value => value.allowed), true, "Owner remains exempt from product AI limits and burst throttle");
  const duplicate = randomUUID(); assert.equal((await quota(service, O, "route", duplicate)).allowed, true);
  assert.equal((await quota(service, O, "route", duplicate)).code, "DUPLICATE_REQUEST");
  const nineUser = randomUUID(); await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'nine@example.invalid',now())", [nineUser]);
  await admin.query("update public.api_entitlements set tier='friend' where user_id=$1", [nineUser]);
  for (let index=0; index<9; index++) assert.equal((await quota(service,nineUser)).allowed,true);
  const last = await Promise.all(workers.map(connection=>quota(connection,nineUser)));
  assert.equal(last.filter(value=>value.allowed).length,1,"Nine prior calls leave only one admission under concurrency");
  console.log("PASS: real 20-transaction burst race, 9-plus-parallel boundary, common five-minute cooldown, user isolation, Owner exemption and duplicate request accounting.");

  const clearAirFixture=async()=>{ await admin.query("delete from public.api_usage_events where service='aviation'; delete from public.api_quota_buckets where service='aviation'"); };
  await clearAirFixture();
  for(let index=0;index<18;index++) assert.equal((await quota(service,F,"flight_actual_match")).allowed,true);
  for(let index=0;index<82;index++) assert.equal((await quota(service,O,"flight_actual_match")).allowed,true,"Owner may use every unused provider-wide request, not just a fixed twenty");
  assert.equal((await quota(service,O,"flight_actual_match")).code,"AVIATION_QUOTA_EXCEEDED");
  assert.equal((await quota(service,F,"flight_actual_match")).code,"AVIATION_QUOTA_EXCEEDED");
  await clearAirFixture();
  for(let index=0;index<80;index++) assert.equal((await quota(service,F,"flight_actual_match")).allowed,true);
  assert.equal((await quota(service,F,"flight_actual_match")).code,"AVIATION_QUOTA_EXCEEDED","Non-owner shared pool never consumes the reserved twenty");
  for(let index=0;index<20;index++) assert.equal((await quota(service,O,"flight_actual_match")).allowed,true);
  await clearAirFixture();
  assert.equal((await quota(service,B,"flight_actual_match")).allowed,true);
  assert.equal((await quota(service,B,"flight_actual_match")).allowed,true);
  assert.equal((await quota(service,B,"flight_actual_match")).code,"AVIATION_QUOTA_EXCEEDED","Standard remains limited to two flights per Shanghai day");
  await admin.query("update public.api_quota_buckets set used_value=9999 where bucket_key like 'deepseek:light:shared:%'");
  assert.equal((await quota(service,B)).allowed,true);
  assert.equal((await quota(service,B)).code,"AI_MONTHLY_QUOTA_EXCEEDED");
  assert.equal((await quota(service,O)).allowed,true);
  assert.equal(Number(await scalar(admin,"select used_value as value from public.api_quota_buckets where bucket_key like 'deepseek:light:shared:%'")),10000,"Owner AI does not consume non-owner shared pool");
  console.log("PASS: provider-wide 100, non-owner 80, Owner borrowing/guaranteed twenty, Standard daily two and light-AI 10000 shared monthly boundary.");

  // Flight version and preview integrity RPCs are intentionally service-only.
  const tripId = randomUUID(), flightId = randomUUID();
  await save(a,"trips",{id:tripId,user_id:A,name:"Flight test",start_date:"2026-09-29",end_date:"2026-10-05",timezone:"Asia/Tokyo"});
  const stop=(date,time,timezone,iata)=>({date,time,timezone,iata,airport:iata,terminal:""});
  const details={airline:"ANA",flight_number:"NH105",departure:stop("2026-09-28","00:50","America/Los_Angeles","LAX"),arrival:stop("2026-09-29","05:00","Asia/Tokyo","HND"),seat:"22A"};
  let flight=(await save(a,"records",{id:flightId,user_id:A,record_type:"trip",content:"Flight",trip_id:tripId,plan_status:"planned",transport_type:"flight",transport_details:details,event_at:"2026-09-28T07:50:00Z"})).row;
  assert.equal(Number(flight.flight_plan_version),1);
  await rejectCode(a.query("select public.claim_flight_match_v2($1,$2,$3,$4,false)",[A,flightId,randomUUID(),1]),"42501");
  const actual={flight_number:"NH105",airline:"ANA",status:"landed",departure:{iata:"LAX",scheduled:{date:"2026-09-28",time:"00:50"}},arrival:{iata:"HND",scheduled:{date:"2026-09-29",time:"05:00"}}};
  const matchRpc=(name,user,requestId,version,info,rematch=false)=>scalar(service,`select public.${name}($1::uuid,$2::uuid,$3::uuid,$4::bigint${name==="claim_flight_match_v2"?",$5::boolean":",$5::jsonb"}) as value`,name==="claim_flight_match_v2"?[user,flightId,requestId,version,rematch]:[user,flightId,requestId,version,info==null?null:json(info)]);
  const oldRequest=randomUUID(); assert.equal((await matchRpc("claim_flight_match_v2",A,oldRequest,1)).ok,true);
  assert.equal((await matchRpc("stage_flight_match_v2",A,oldRequest,1,actual)).ok,true);
  flight=(await scalar(admin,"select to_jsonb(r) as value from public.records r where id=$1",[flightId]));
  flight=(await save(a,"records",{id:flightId,user_id:A,transport_details:{...details,flight_number:"NH999"}},flight.updated_at)).row;
  assert.equal(Number(flight.flight_plan_version),2); assert.equal(flight.actual_info_matched,false);
  assert.equal((await matchRpc("confirm_flight_match_v2",A,oldRequest,1,null)).code,"PLAN_CHANGED");
  assert.equal((await matchRpc("stage_flight_match_v2",A,oldRequest,1,actual)).code,"PLAN_CHANGED");
  assert.equal((await matchRpc("claim_flight_match_v2",B,randomUUID(),2)).code,"RECORD_NOT_FOUND");
  const newRequest=randomUUID(); assert.equal((await matchRpc("claim_flight_match_v2",A,newRequest,2)).ok,true);
  const currentActual={...actual,flight_number:"NH999"};
  assert.equal((await matchRpc("stage_flight_match_v2",A,newRequest,2,currentActual)).ok,true);
  const confirmed=await matchRpc("confirm_flight_match_v2",A,newRequest,2,null);
  assert.equal(confirmed.ok,true); assert.equal(confirmed.record.actual_info_matched,true); assert.equal(Number(confirmed.record.actual_match_plan_version),2);
  assert.equal(confirmed.record.actual_confirmed_request_id,newRequest);
  assert.equal((await matchRpc("confirm_flight_match_v2",A,newRequest,2,null)).ok,true,"Confirmation response retries are idempotent");
  const requestB=randomUUID(),actualB={...currentActual,registration:"REMATCH-B"};
  assert.equal((await matchRpc("claim_flight_match_v2",A,requestB,2,null,true)).cached,false);
  assert.equal((await matchRpc("stage_flight_match_v2",A,requestB,2,actualB)).ok,true);
  const confirmAWhileBPending=await matchRpc("confirm_flight_match_v2",A,newRequest,2,null);
  assert.equal(confirmAWhileBPending.record.actual_confirmed_request_id,newRequest);
  assert.equal(confirmAWhileBPending.record.actual_info.registration,undefined);
  assert.equal(Number(await scalar(admin,"select count(*) as value from public.flight_match_previews where request_id=$1",[requestB])),1,"Idempotent confirmation of A must not consume pending B");
  const confirmB=await matchRpc("confirm_flight_match_v2",A,requestB,2,null);
  assert.equal(confirmB.record.actual_confirmed_request_id,requestB);assert.equal(confirmB.record.actual_info.registration,"REMATCH-B");
  assert.equal((await matchRpc("confirm_flight_match_v2",A,requestB,2,null)).record.actual_info.registration,"REMATCH-B");
  flight=confirmB.record;
  flight=(await save(a,"records",{id:flightId,user_id:A,notes:"seat only",transport_details:{...flight.transport_details,seat:"18K"}},flight.updated_at)).row;
  assert.equal(Number(flight.flight_plan_version),2); assert.equal(flight.actual_info_matched,true);
  await a.query("update public.records set actual_info_matched=false, actual_info=$1::jsonb, flight_plan_version=999,actual_confirmed_request_id=$3 where id=$2",[json({forged:true}),flightId,randomUUID()]);
  flight=await scalar(admin,"select to_jsonb(r) as value from public.records r where id=$1",[flightId]);
  assert.equal(Number(flight.flight_plan_version),2); assert.equal(flight.actual_info_matched,true); assert.equal(flight.actual_info.flight_number,"NH999");
  assert.equal(flight.actual_confirmed_request_id,requestB,"Authenticated raw updates cannot forge confirmed result UUID");
  const cached=await matchRpc("claim_flight_match_v2",A,randomUUID(),2); assert.equal(cached.cached,true);
  flight=(await save(a,"records",{id:flightId,user_id:A,transport_details:{...flight.transport_details,arrival:{...flight.transport_details.arrival,time:"06:00"}}},flight.updated_at)).row;
  assert.equal(Number(flight.flight_plan_version),3); assert.equal(flight.actual_info_matched,false); assert.equal(flight.actual_match_request_id,null);
  assert.equal(flight.actual_confirmed_request_id,null);
  assert.equal(flight.actual_info.flight_number,"NH999","Historical actual payload remains preserved but not current");
  console.log("PASS: flight semantic versions, stale in-flight preview and confirm rejection, service-only RPCs, ownership, idempotent confirm, metadata retention, forged actual protection and historical payload preservation.");

  const legacyClaim=requestId=>scalar(service,"select public.claim_flight_match($1,$2,$3,false) as value",[A,flightId,requestId]);
  const legacyFinish=(requestId,info)=>scalar(service,"select public.finish_flight_match($1,$2,$3,'matched',$4::jsonb) as value",[A,flightId,requestId,json(info)]);
  const legacyInsert=(requestId,info)=>service.query("insert into public.flight_match_previews(request_id,record_id,user_id,actual_info) values($1,$2,$3,$4::jsonb)",[requestId,flightId,A,json(info)]);
  const provedActual=plan=>({flight_number:plan.flight_number,status:"landed",airline:plan.airline,departure:{iata:plan.departure.iata,timezone:plan.departure.timezone,scheduled:{date:plan.departure.date,time:plan.departure.time}},arrival:{iata:plan.arrival.iata,timezone:plan.arrival.timezone,scheduled:{date:plan.arrival.date,time:plan.arrival.time}}});
  const legacyRequest=randomUUID(); assert.equal((await legacyClaim(legacyRequest)).ok,true);
  assert.equal((await legacyFinish(legacyRequest,{forged:true})).code,"PLAN_VERSION_REQUIRED","Legacy callers cannot confirm without a version-bound preview");
  const legacyInfo=provedActual(flight.transport_details); await legacyInsert(legacyRequest,legacyInfo);
  assert.equal(Number(await scalar(admin,"select plan_version as value from public.flight_match_previews where request_id=$1",[legacyRequest])),3);
  let legacyConfirmed=await legacyFinish(legacyRequest,{flight_number:"FORGED",forged:true});
  assert.equal(legacyConfirmed.ok,true); assert.equal(legacyConfirmed.record.actual_info.flight_number,"NH999"); assert.equal(legacyConfirmed.record.actual_info.forged,undefined,"Legacy supplied payload is ignored in favor of stored proof");
  assert.equal((await legacyFinish(legacyRequest,{forged:true})).ok,true,"Legacy successful network retry is idempotent");
  flight=(await save(a,"records",{id:flightId,user_id:A,transport_details:{...legacyConfirmed.record.transport_details,arrival:{...legacyConfirmed.record.transport_details.arrival,time:"07:00"}}},legacyConfirmed.record.updated_at)).row;
  const newerLegacyRequest=randomUUID(); assert.equal((await legacyClaim(newerLegacyRequest)).ok,true);
  await rejectCode(legacyInsert(newerLegacyRequest,legacyInfo),"23514","Old read-before-claim snapshot cannot be assigned the new version");
  await legacyInsert(newerLegacyRequest,provedActual(flight.transport_details));
  flight=await scalar(admin,"select to_jsonb(r) as value from public.records r where id=$1",[flightId]);
  flight=(await save(a,"records",{id:flightId,user_id:A,transport_details:{...flight.transport_details,flight_number:"NH888"}},flight.updated_at)).row;
  assert.equal((await legacyFinish(newerLegacyRequest,provedActual(flight.transport_details))).code,"PLAN_CHANGED","Legacy preview also rejects edits after staging");
  console.log("PASS: safe SQL-first legacy bridge, omitted-version proof, no-preview refusal, untrusted payload ignored, old-read/new-claim mismatch and stale legacy confirmation.");

  // Explicit UTC occurrence is part of the immutable segment, not a display
  // preference. Legacy NULL/missing choices are accepted only for unique clocks.
  assert.deepEqual(await scalar(admin,"select public.flight_local_utc_offsets('2026-11-01','01:30','America/Los_Angeles') as value"),[-420,-480]);
  assert.deepEqual(await scalar(admin,"select public.flight_local_utc_offsets('2026-04-05','01:45','Australia/Lord_Howe') as value"),[660,630]);
  assert.deepEqual(await scalar(admin,"select public.flight_local_utc_offsets('2026-03-08','02:30','America/Los_Angeles') as value"),[]);
  const repeatedDetails={...flight.transport_details,departure:{...flight.transport_details.departure,date:"2026-11-01",time:"01:30",utc_offset_minutes:-420},arrival:{...flight.transport_details.arrival,date:"2026-11-02",time:"03:30"}};
  flight=(await save(a,"records",{id:flightId,user_id:A,transport_details:repeatedDetails,event_at:"2026-11-01T08:30:00Z"},flight.updated_at)).row;
  const firstVersion=Number(flight.flight_plan_version),firstOccurrence=randomUUID();
  const firstActual=provedActual(flight.transport_details);
  firstActual.departure.scheduled.iso="2026-11-01T01:30:00-07:00";
  assert.equal((await matchRpc("claim_flight_match_v2",A,firstOccurrence,firstVersion)).ok,true);
  assert.equal((await matchRpc("stage_flight_match_v2",A,firstOccurrence,firstVersion,firstActual)).ok,true);
  flight=await scalar(admin,"select to_jsonb(r) as value from public.records r where id=$1",[flightId]);
  const secondDetails={...flight.transport_details,departure:{...flight.transport_details.departure,utc_offset_minutes:-480}};
  flight=(await save(a,"records",{id:flightId,user_id:A,transport_details:secondDetails,event_at:"2026-11-01T09:30:00Z"},flight.updated_at)).row;
  assert.equal(Number(flight.flight_plan_version),firstVersion+1,"Only changing the UTC occurrence must increment segment version");
  assert.equal(flight.actual_match_request_id,null); assert.equal(flight.actual_info_matched,false);
  assert.equal((await matchRpc("confirm_flight_match_v2",A,firstOccurrence,firstVersion,null)).code,"PLAN_CHANGED");
  const selectedLegacy=randomUUID(); assert.equal((await legacyClaim(selectedLegacy)).ok,true);
  await rejectCode(legacyInsert(selectedLegacy,firstActual),"23514","A first-occurrence ISO cannot prove the selected second occurrence");
  await rejectCode(legacyInsert(selectedLegacy,provedActual(flight.transport_details)),"23514","Missing ISO cannot prove an explicit UTC choice");
  const secondActual=provedActual(flight.transport_details); secondActual.departure.scheduled.iso="2026-11-01T01:30:00-08:00";
  assert.equal(await scalar(admin,"select public.flight_stop_offset_proved($1::jsonb,$2::jsonb) as value",[json({...flight.transport_details.departure,utc_offset_minutes:"-480"}),json(secondActual.departure)]),false,"A string offset cannot bypass numeric proof");
  await legacyInsert(selectedLegacy,secondActual);
  const secondConfirmed=await legacyFinish(selectedLegacy,firstActual);
  assert.equal(secondConfirmed.record.actual_info.departure.scheduled.iso,"2026-11-01T01:30:00-08:00","Legacy finish ignores supplied first-occurrence payload");
  flight=secondConfirmed.record;
  flight=(await save(a,"records",{id:flightId,user_id:A,transport_details:{...flight.transport_details,departure:{...flight.transport_details.departure,utc_offset_minutes:null}}},flight.updated_at)).row;
  const noChoiceVersion=Number(flight.flight_plan_version);
  const missingChoice={...flight.transport_details.departure}; delete missingChoice.utc_offset_minutes;
  flight=(await save(a,"records",{id:flightId,user_id:A,transport_details:{...flight.transport_details,departure:missingChoice}},flight.updated_at)).row;
  assert.equal(Number(flight.flight_plan_version),noChoiceVersion,"NULL and omitted choices have the same signature");
  const unselectedLegacy=randomUUID(); assert.equal((await legacyClaim(unselectedLegacy)).code,"AMBIGUOUS_FLIGHT_TIME","Old Edge must be rejected before it can reserve quota or call upstream");
  await rejectCode(legacyInsert(unselectedLegacy,secondActual),"23514","A legacy ambiguous plan without choice cannot gain a proved version");
  assert.equal(await scalar(admin,"select public.flight_stop_offset_proved($1::jsonb,$2::jsonb) as value",[json({...missingChoice,date:"2026-11-01",time:"02:30"}),json(secondActual.departure)]),true,"Unique legacy clocks keep offset-free compatibility");
  console.log("PASS: DST occurrence semantic version, stale preview/confirm invalidation, 30-minute rollback, nonexistent clocks, numeric-only ISO proof and safe NULL/missing legacy compatibility.");

  flight=(await save(a,"records",{id:flightId,user_id:A,transport_details:{...flight.transport_details,departure:{...flight.transport_details.departure,utc_offset_minutes:-480}},plan_status:"planned"},flight.updated_at)).row;
  const cancelledVersion=Number(flight.flight_plan_version),cancelledRequest=randomUUID();
  assert.equal((await matchRpc("claim_flight_match_v2",A,cancelledRequest,cancelledVersion)).ok,true);
  assert.equal((await matchRpc("stage_flight_match_v2",A,cancelledRequest,cancelledVersion,secondActual)).ok,true);
  flight=await scalar(admin,"select to_jsonb(r) as value from public.records r where id=$1",[flightId]);
  flight=(await save(a,"records",{id:flightId,user_id:A,plan_status:"cancelled"},flight.updated_at)).row;
  assert.equal(Number(flight.flight_plan_version),cancelledVersion,"Status alone is not a new semantic segment");
  assert.equal((await legacyClaim(randomUUID())).code,"FLIGHT_CANCELLED");
  assert.equal((await matchRpc("claim_flight_match_v2",A,randomUUID(),cancelledVersion)).code,"FLIGHT_CANCELLED");
  assert.equal((await matchRpc("stage_flight_match_v2",A,cancelledRequest,cancelledVersion,secondActual)).code,"FLIGHT_CANCELLED");
  assert.equal((await matchRpc("confirm_flight_match_v2",A,cancelledRequest,cancelledVersion,null)).code,"FLIGHT_CANCELLED");
  assert.equal((await legacyFinish(cancelledRequest,secondActual)).code,"FLIGHT_CANCELLED");
  assert.equal(Number(await scalar(admin,"select count(*) as value from public.flight_match_previews where request_id=$1",[cancelledRequest])),1,"Rejected cancelled confirms do not consume the retained preview");
  flight=(await save(a,"records",{id:flightId,user_id:A,plan_status:"planned"},flight.updated_at)).row;
  assert.equal(Number(flight.flight_plan_version),cancelledVersion);
  assert.equal((await matchRpc("confirm_flight_match_v2",A,cancelledRequest,cancelledVersion,null)).ok,true,"Restoring planned re-enables valid confirmation without another API request");
  console.log("PASS: cancelled old/new claims, preview staging and confirmation are rejected, status preserves semantic version and restoring planned reuses the valid preview.");

  // Persistence retries share one transaction with usage completion and cannot
  // replace a newer cached result or cross an identity/context boundary.
  const reserve=async(feature)=>{ const requestId=randomUUID(); await admin.query("insert into public.api_usage_events(request_id,user_id,service,feature,quota_group,tier) values($1,$2,'deepseek',$3,$4,'standard')",[requestId,A,feature,feature==="trip_recap"?"recap":feature==="daily_summary"?"summary":"light"]); return requestId; };
  const cacheRpc=(connection, requestId, feature, content, generatedAt, contextKey=null, ownedTrip=null,summaryDate="2026-10-01")=>scalar(connection,"select public.store_ai_result($1::uuid,$2::uuid,$3,$4,$5::timestamptz,$6::uuid,$7::date,$8,$9,$10::jsonb) as value",[A,requestId,feature,content,generatedAt,ownedTrip,feature==="daily_summary"?summaryDate:null,contextKey,feature==="trip_recap"?"c".repeat(64):null,json({test:true})]);
  const generatedOld=new Date(Date.now()-3_600_000).toISOString(), generatedNew=new Date(Date.now()-1_800_000).toISOString(), generatedFailure=new Date(Date.now()-900_000).toISOString();
  const cacheOne=await reserve("daily_summary"), cacheTwo=await reserve("daily_summary"), contextA="a".repeat(64), contextB="b".repeat(64);
  await rejectCode(cacheRpc(a,cacheOne,"daily_summary","denied",generatedOld,contextA),"42501");
  await rejectCode(scalar(service,"select public.store_ai_result($1,$2,'daily_summary','foreign',now(),null,'2026-10-01',$3,null,null) as value",[B,cacheOne,contextA]),"42501");
  assert.equal((await cacheRpc(service,cacheOne,"daily_summary","context A",generatedOld,contextA)).saved,true);
  assert.equal((await cacheRpc(service,cacheTwo,"daily_summary","context B",generatedOld,contextB)).saved,true);
  assert.equal(Number(await scalar(admin,"select count(*) as value from public.daily_summaries where user_id=$1 and summary_date='2026-10-01'",[A])),2,"Same anchor date keeps distinct trip-local-day contexts");
  assert.equal((await cacheRpc(service,cacheOne,"daily_summary","context A",generatedOld,contextA)).saved,true);
  assert.equal(Number(await scalar(admin,"select count(*) as value from public.daily_summaries where user_id=$1 and context_key=$2",[A,contextA])),1);
  const midnightRetry=await reserve("daily_summary");
  assert.equal((await cacheRpc(service,midnightRetry,"daily_summary","same trip day",generatedOld,contextA,null,"2026-10-02")).saved,true);
  assert.equal(Number(await scalar(admin,"select count(*) as value from public.daily_summaries where user_id=$1 and context_key=$2",[A,contextA])),1,"Shanghai report date does not create a second cache for one unchanged trip-local context");
  const newer=await reserve("daily_summary");
  assert.equal((await cacheRpc(service,newer,"daily_summary","newest content",generatedNew,contextA)).saved,true);
  assert.equal((await cacheRpc(service,cacheOne,"daily_summary","older recovery",generatedOld,contextA)).newerPreserved,true);
  assert.equal(await scalar(admin,"select content as value from public.daily_summaries where user_id=$1 and context_key=$2",[A,contextA]),"newest content");
  assert.equal(await scalar(admin,"select status as value from public.api_usage_events where request_id=$1",[cacheOne]),"completed");
  const failingCache=await reserve("daily_summary"), contextC="d".repeat(64);
  await admin.query(`create function public.test_reject_usage_completion() returns trigger language plpgsql as $$ begin if new.request_id='${failingCache}'::uuid then raise exception 'injected cache completion failure' using errcode='23514'; end if; return new; end $$; create trigger test_reject_usage_completion before update on public.api_usage_events for each row execute function public.test_reject_usage_completion()`);
  await rejectCode(cacheRpc(service,failingCache,"daily_summary","recoverable result",generatedFailure,contextC),"23514");
  assert.equal(Number(await scalar(admin,"select count(*) as value from public.daily_summaries where user_id=$1 and context_key=$2",[A,contextC])),0,"Cache and completion roll back together");
  assert.equal(await scalar(admin,"select status as value from public.api_usage_events where request_id=$1",[failingCache]),"reserved","Previously reserved upstream call is not refunded or recreated");
  await admin.query("drop trigger test_reject_usage_completion on public.api_usage_events; drop function public.test_reject_usage_completion()");
  assert.equal((await cacheRpc(service,failingCache,"daily_summary","recoverable result",generatedFailure,contextC)).saved,true);
  assert.equal(Number(await scalar(admin,"select count(*) as value from public.api_usage_events where request_id=$1",[failingCache])),1,"Save-only recovery does not reserve another upstream request");
  const recapRequest=await reserve("trip_recap");
  assert.equal((await cacheRpc(service,recapRequest,"trip_recap","recap",generatedOld,null,tripId)).saved,true);
  const otherTrip=randomUUID(); await save(b,"trips",{id:otherTrip,user_id:B,name:"Foreign trip",start_date:"2026-09-01",end_date:"2026-09-02",timezone:"UTC"});
  await rejectCode(cacheRpc(service,recapRequest,"trip_recap","foreign recap",generatedOld,null,otherTrip),"42501");
  assert.equal(Number(await scalar(admin,"select count(*) as value from public.trip_recaps where user_id=$1 and trip_id=$2",[A,tripId])),1);
  console.log("PASS: service-only atomic AI cache/usage completion, principal binding, trip ownership, distinct daily contexts, repeated save idempotence and newer-cache preservation.");
  console.log("PASS: database acceptance completed without production network or upstream API calls.");
} catch(error) {
  failed = true; console.error(error); if(error.cause) console.error(error.cause); console.error(logs.slice(-5).join("\n"));
} finally {
  for(const connection of clients) await connection.end().catch(()=>{});
  await cluster.stop();
}
exit(failed ? 1 : 0);
