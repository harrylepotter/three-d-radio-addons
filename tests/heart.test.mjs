import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driveHandler } from "../three_d_radio_likes/drive.mjs";

test("a widget can receive the first match while the HA callback and playlist are unavailable", async t => {
  const directory = mkdtempSync(join(tmpdir(),"three-d-start-"));
  t.after(() => rmSync(directory,{recursive:true,force:true}));
  const time = 1800000000;
  let changes = 0;
  const handle = driveHandler({
    historyFile:join(directory,"history"), now:() => time * 1000,
    state:async () => { throw new Error("HA callback timed out"); },
    playlistTracks:async () => { throw new Error("MA is busy"); },
    pending:() => null, widgetPush:{changed:() => changes++}
  });
  const timer_state = {state:"active",attributes:{finishes_at:new Date((time+7200)*1000).toISOString()}};
  const match_state = {state:"matched",attributes:{ts:time,artist:"Artist",title:"First song"}};
  await handle({operation:"widget_changed",timer_state,match_state});
  assert.equal(changes,1);
  const current = await handle({operation:"status",timer_state,match_state});
  assert.equal(current.track.title,"First song");
  assert.equal(current.liked,null);
  const ended = await handle({operation:"status",timer_state:{state:"idle",attributes:{}}});
  assert.equal(ended.active,false);
  await assert.rejects(handle({operation:"like_current",timer_state,match_state}), /HA callback/);
});

test("car heart saves its displayed track across a change and rejects expired sessions", async t => {
  const directory = mkdtempSync(join(tmpdir(),"three-d-heart-"));
  t.after(() => rmSync(directory,{recursive:true,force:true}));
  let time = 1800000000;
  let session = new Date((time+7200)*1000).toISOString();
  let active = false;
  const song = {artist:"Artist",title:"First",isrc:"X",ts:time,art_url:"https://example.invalid/first.jpg"};
  const requests = [];
  const dependencies = {
    historyFile:join(directory,"seen.json"), now:()=>time*1000,
    state:async entity => entity.startsWith("timer.") ?
      {state:active ? "active":"idle",attributes:{finishes_at:session}} : {state:"match",attributes:song},
    playlistTracks:async()=>[], pending:()=>null, enqueue:request=>requests.push(request),
    fetchCover:async(source,stillCurrent)=>({source,stillCurrent:await stillCurrent()})
  };
  let handle=driveHandler(dependencies);
  assert.equal((await handle({operation:"like_current"})).active,false);
  active=true;
  const first=(await handle({operation:"status"})).track;
  Object.assign(song,{title:"Second",isrc:"Y",ts:++time,art_url:null});
  const second=(await handle({operation:"status"})).track;
  assert.notEqual(second.id,first.id);
  handle=driveHandler(dependencies);
  assert.deepEqual((await handle({operation:"artwork",track_id:first.id})).image,{source:"https://example.invalid/first.jpg",stillCurrent:false});
  assert.equal((await handle({operation:"artwork",track_id:second.id})).image,null);
  assert.equal((await handle({operation:"like",track_id:first.id})).accepted,true);
  assert.equal(requests[0].title,"First");
  assert.equal((await handle({operation:"like_current"})).track.title,"Second");
  time+=301;
  assert.equal((await handle({operation:"status"})).track,null);
  assert.equal((await handle({operation:"like",track_id:first.id})).accepted,false);
  session=new Date((time+7200)*1000).toISOString();
  song.ts=time;
  assert.equal((await handle({operation:"like",track_id:second.id})).accepted,false);
  active=false;
  assert.equal((await handle({operation:"like",track_id:first.id})).active,false);
  assert.equal(requests.length,2);
});

test("drive widget captures the match on change, labels stale songs and forgets them in the next session", async t => {
  const directory = mkdtempSync(join(tmpdir(), "three-d-widget-"));
  t.after(() => rmSync(directory, {recursive:true, force:true}));
  let time = 1800000000, end = time + 7200, active = false, changes = 0;
  const song = {ts:time, artist:"Artist", title:"Track"};
  const handle = driveHandler({
    historyFile:join(directory, "history"), now:() => time * 1000,
    state:async entity => entity.startsWith("timer.") ?
      {state:active ? "active":"idle", attributes:{finishes_at:new Date(end*1000).toISOString()}} :
      {state:"match", attributes:song},
    playlistTracks:async () => [], pending:() => null,
    widgetPush:{register:token => token === "ab", changed:() => changes++}
  });
  assert.deepEqual(await handle({operation:"register_widget", push_token:"ab"}), {registered:true});
  active = true;
  await handle({operation:"widget_changed"});
  assert.equal(changes, 1);
  time += 151;
  const status = await handle({operation:"status"});
  assert.equal(status.track, null);
  assert.equal(status.lastTrack.title, "Track");
  assert.equal(status.endsAt, end);
  time += 150;
  assert.equal((await handle({operation:"like", track_id:status.lastTrack.id})).accepted, false);
  end += 1000;
  assert.equal((await handle({operation:"status"})).lastTrack, undefined);
  active = false;
  assert.equal((await handle({operation:"widget_changed"})).active, false);
  assert.equal(changes, 2);
});
