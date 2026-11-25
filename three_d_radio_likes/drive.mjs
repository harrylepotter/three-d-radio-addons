import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { songKey, sameRecording } from "./recording.mjs";

const freshness = 150; // The station is fingerprinted every 60 seconds.
const operations = ["status","like","like_current","artwork","register_widget","widget_changed"];
export function driveHandler({state, playlistTracks, enqueue, pending, historyFile, fetchCover, widgetPush, recognitionSensor = "sensor.radio_stream_match", now = Date.now}) {
  let history = existsSync(historyFile) ? JSON.parse(readFileSync(historyFile)) : {};
  function persist() {
    writeFileSync(historyFile + ".tmp", JSON.stringify(history), {mode:0o600});
    renameSync(historyFile + ".tmp",historyFile);
  }
  return async function handle({operation, track_id = "", push_token}) {
    if (!operations.includes(operation)) throw new Error("Unknown drive action");
    if (operation === "register_widget") return {registered:widgetPush.register(push_token)};
    const timer = await state("timer.three_d_drive");
    const ends = Date.parse(timer.attributes.finishes_at || "");
    const time = Math.floor(now()/1000);
    if (timer.state !== "active" || !Number.isFinite(ends) || ends <= time*1000) {
      if (operation === "widget_changed") widgetPush.changed();
      return {active:false, message:"Start Three D first"};
    }
    const session = timer.attributes.finishes_at;
    const rec = await state(recognitionSensor);
    const a = rec.attributes;
    let current = null;
    const seen = Number(a.ts);
    if (!["unknown","unavailable","idle"].includes(rec.state) && a.artist && a.title &&
        Number.isFinite(seen) && seen <= time + 5 && time-seen <= freshness) {
      const song = {artist:a.artist,title:a.title,isrc:a.isrc || ""};
      const id = createHash("sha256").update(session + "|" + songKey(song)).digest("hex");
      current = {...song,id,seen,artwork:a.art_url || null};
      if (history.session !== session) history={session,tracks:{}};
      if (!history.tracks[id] || seen > history.tracks[id].seen || history.tracks[id].artwork !== current.artwork) {
        history.tracks[id]=current;
        for (const [k,v] of Object.entries(history.tracks)) if (time-v.seen > 300) delete history.tracks[k];
        persist();
      }
    }
    if (operation === "widget_changed") {
      widgetPush.changed();
      return {active:true};
    }
    if (operation !== "status") {
      const selected = operation === "like_current" ? current :
        (history.session === session && /^[a-f0-9]{64}$/.test(track_id) ? history.tracks[track_id] : null);
      if (!selected) return {active:true, accepted:false,message:"Recording no longer available."};
      if (operation === "artwork") {
        const stillCurrent = async () => (await state(recognitionSensor)).attributes.art_url === selected.artwork;
        return {image:selected.artwork ? await fetchCover(selected.artwork,stillCurrent) : null};
      }
      if (time-selected.seen > 300) return {active:true, accepted:false,message:"Recording is too old to like."};
      const {artist,title,isrc} = selected;
      enqueue({artist,title,isrc});
      return {active:true,accepted:true,track:selected,message:"Heart received"};
    }
    const lastTrack = !current && history.session === session ?
      Object.values(history.tracks).sort((a,b) => b.seen-a.seen)[0] : undefined;
    const displayed = current || lastTrack;
    let liked = false;
    if (displayed && time-displayed.seen <= 300) {
      const request = pending(displayed);
      liked = request ? !request.remove : (await playlistTracks()).some(t=>sameRecording(displayed,t));
    }
    return {active:true,endsAt:ends/1000,track:current,lastTrack,liked,message:current ? "Three D Radio" : "Listening for a match"};
  };
}
export function serveDrive(secret, handle) {
  const expected=Buffer.from("Bearer "+secret);
  createServer(async (req,res) => {
    const reply=(code, data)=>res.writeHead(code,{"Content-Type":"application/json","Cache-Control":"no-store"}).end(JSON.stringify(data));
    const auth=Buffer.from(req.headers.authorization || "");
    if (req.url !== "/drive" || req.method !== "POST") return reply(404,{error:"Not found"});
    if (auth.length!==expected.length || !timingSafeEqual(auth,expected)) return reply(401,{error:"Unauthorized"});
    try {
      let body="";
      for await (const part of req) {
        body+=part;
        if (body.length>2048) return reply(413,{error:"Too large"});
      }
      let input;
      try { input=JSON.parse(body); } catch { return reply(400,{error:"Invalid request"}); }
      if (!operations.includes(input?.operation)) return reply(400,{error:"Invalid operation"});
      return reply(200,await handle(input));
    } catch (err) {
      console.warn("Car request:",err.message);
      return reply(503,{error:"Three D temporarily unavailable"});
    }
  }).listen(8754,"0.0.0.0");
}

// The provider URL comes from a recognized track in the server's own history.
// Keep the image bound to that recording if the station changes during a request.
const covers = new Map();
export async function fetchDriveCover(source, stillCurrent, coverEntity) {
  if (covers.has(source)) return covers.get(source);
  const url = URL.parse(source);
  let res;
  if (url?.protocol === "https:" && url.hostname.endsWith(".mzstatic.com") && !url.port && !url.username && !url.password) {
    res = await fetch(url,{redirect:"error",signal:AbortSignal.timeout(4500)}).catch(() => null);
  }
  const usingProxy = !res?.ok;
  if (usingProxy) {
    if (!(await stillCurrent())) return null;
    res=await fetch("http://supervisor/core/api/image_proxy/" + encodeURIComponent(coverEntity),{
      headers:{Authorization:"Bearer "+process.env.SUPERVISOR_TOKEN},redirect:"error",signal:AbortSignal.timeout(4500)
    });
    if (!res.ok) return null;
  }
  const parts=[];
  let size=0;
  for await (const bytes of res.body) {
    size+=bytes.length;
    if (size>768*1024) return null;
    parts.push(bytes);
  }
  const data=Buffer.concat(parts);
  if (usingProxy && !(await stillCurrent())) return null;
  if (!(data[0]===0xff && data[1]===0xd8) && !data.subarray(0,8).equals(Buffer.from("89504e470d0a1a0a","hex"))) return null;
  const image=data.toString("base64");
  covers.set(source,image);
  if (covers.size>6) covers.delete(covers.keys().next().value);
  return image;
}
