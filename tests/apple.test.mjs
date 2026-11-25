import assert from "node:assert/strict";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {appleSync} from "../three_d_radio_likes/apple.mjs";
const instance="apple_music--test", pp={provider_domain:"apple_music",provider_instance:instance,item_id:"p.example"};
const row=id=>({provider_mappings:[{...pp,item_id:id,available:true}]});
const source=[row("1"),row("1"),row("2"),{provider_mappings:[{provider_domain:"three_d_radio_likes",available:false}]}];
let remote=[row("1")], writes=[], now=1e8, fail=false;
const opts={sourceId:"101",destinationUri:"library://playlist/202",dataDir:mkdtempSync(join(tmpdir(),"three-d-apple-check-")),sourceTracks:async()=>source,now:()=>now,wait:async()=>{},music:async(cmd,args)=>{
 if(cmd==="music/item_by_uri")return {is_editable:true,provider_mappings:[pp]};
 if(cmd==="music/playlists/playlist_tracks")return remote;
 assert.equal(args.db_playlist_id,"202");assert.equal(cmd,"music/playlists/add_playlist_tracks");writes.push(args.uris);
 if(fail)throw new Error("simulated uncertain response");
 remote.push(...args.uris.map(u=>row(u.split("/").at(-1))));
}};
let listener=appleSync(opts);await Promise.all([listener.sync(),listener.sync()]);
assert.deepEqual(writes,[[instance+"://track/2"]]);remote=[];listener=appleSync(opts);await listener.sync();assert.equal(writes.length,1);
source.push(row("3"));fail=true;await assert.rejects(listener.sync);await listener.sync();assert.equal(writes.length,2);
remote=[row("3")];now+=3600000;await listener.sync();assert.equal(writes.length,2);
source.push(row("4"));await assert.rejects(listener.sync);now+=3600000;fail=false;await listener.sync();assert.equal(writes.at(-1)[0],instance+"://track/4");
listener.remember(row("5"));listener=appleSync(opts);await listener.sync();assert.equal(writes.at(-1)[0],instance+"://track/5");
remote=[];listener.remember(row("5"));await listener.sync();assert.equal(writes.length,5);
console.log("Verified backfill, skipped unavailable tracks, duplicates, manual Apple removal, immediate kiosk unlike, restarts and retries.");
let calls=0;
const optsFast={...opts,dataDir:mkdtempSync(join(tmpdir(),"three-d-apple-receipt-")),sourceTracks:async()=>[row("9")],music:async(cmd,args)=>{
 if(cmd==="music/playlists/playlist_tracks")return [];
 if(cmd==="music/playlists/add_playlist_tracks"){calls++;return {id:"receipt"};}
 if(cmd==="tasks/get"){assert.equal(args.task_id,"receipt");return {status:"success"};}
 return {is_editable:true,provider_mappings:[pp]};
}};
await appleSync(optsFast).sync();
now+=3600000;await appleSync(optsFast).sync();
assert.equal(calls,1);console.log("Verified immediate manual Apple removal survives a restart before read-back.");
