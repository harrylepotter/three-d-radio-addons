import { readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { bookmark, playingSong, sameRecording, songKey, stationPlayers } from "./recording.mjs";
import { appleSync } from "./apple.mjs";
import { driveHandler, fetchDriveCover, serveDrive } from "./drive.mjs";
import { apnsSender, widgetNotifications } from "./widget-push.mjs";

const options = JSON.parse(readFileSync("/data/options.json"));
const playlist = /^library:\/\/playlist\/(\d+)$/.exec(options.playlist_uri)?.[1];
if (!playlist || !options.music_token || !options.station_uris.length || !options.players.length) {
  throw new Error("Configure the playlist, radio stations, players and Music Assistant connection.");
}
const pendingFile = "/data/pending-" + playlist + ".json";
const pending = existsSync(pendingFile) ? JSON.parse(readFileSync(pendingFile)) : [];
let processing = false;
function persist() {
  writeFileSync(pendingFile + ".tmp", JSON.stringify(pending), {mode: 0o600});
  renameSync(pendingFile + ".tmp", pendingFile);
}
async function music(command, args) {
  const r = await fetch(new URL("/api", options.music_url), {
    method: "POST", headers: {Authorization: "Bearer " + options.music_token, "Content-Type": "application/json"},
    body: JSON.stringify({message_id:"radio-likes",command,args}), redirect:"error", signal:AbortSignal.timeout(30000)
  });
  if (!r.ok) throw new Error(command + " returned HTTP " + r.status);
  return r.json();
}
async function state(entity) {
  const r = await fetch("http://supervisor/core/api/states/" + encodeURIComponent(entity), {
    headers: {Authorization:"Bearer " + process.env.SUPERVISOR_TOKEN}, redirect:"error", signal:AbortSignal.timeout(4000)
  });
  if (!r.ok) throw new Error(entity + " returned HTTP " + r.status);
  return r.json();
}
const playlistTracks = () => music("music/playlists/playlist_tracks", {
  item_id:playlist, provider_instance_id_or_domain:"library", force_refresh:true
});
const apple = options.apple_playlist_uri && appleSync({sourceId:playlist, destinationUri:options.apple_playlist_uri,
  dataDir:"/data", music, sourceTracks:playlistTracks});
function queueAppleTrack(track) {
  if (!apple) return;
  apple.remember(track);
  void refreshApple();
}
function refreshApple() {
  return apple.sync().catch(err => console.warn("Apple Music playlist sync:",err.message));
}
async function resolve(song) {
  const results = await music("music/search", {
    search_query:song.artist + " " + song.title, media_types:["track"], providers:["apple_music","library"], limit:25
  });
  const matches = (results.tracks || []).filter(t => t.provider_mappings?.some(m => m.available !== false) && sameRecording(song,t));
  return matches.find(t => song.isrc && t.external_ids?.some(([k,v]) => k === "isrc" && v === song.isrc)) || matches[0];
}
async function save(song) {
  const rows = await playlistTracks();
  const entry = rows.find(t => sameRecording(song,t));
  const playable = t => t?.provider_mappings?.some(m => m.available !== false && m.provider_domain !== "three_d_radio_likes");
  if (playable(entry)) {
    queueAppleTrack(entry);
    return true;
  }
  const match = await resolve(song).catch(err => {
    console.warn("Catalog lookup deferred:",err.message);
    return null;
  });
  if (entry && !match) return false;
  if (entry && match) {
    // Preserve the library identity of the bookmark and its position in the M3U.
    // MA resolves the stored, offline mapping via the enriched library copy.
    const enriched = {...match,provider:"builtin",item_id:bookmark(song).item_id,
      provider_mappings:[...entry.provider_mappings,...match.provider_mappings]};
    await music("music/library/add_item",{item:enriched});
  } else {
    const track = match || await music("music/library/add_item",{item:bookmark(song)});
    await music("music/playlists/add_playlist_tracks", {db_playlist_id:playlist,uris:[track.uri]});
  }
  // Writes may run as background tasks; verify before acknowledging the press.
  for (const ms of [900,1800,3500,6000]) {
    await delay(ms);
    const saved = (await playlistTracks()).find(t => sameRecording(song,t));
    if (saved && (!match || playable(saved))) {
      if (match) queueAppleTrack(saved);
      return Boolean(match);
    }
  }
  throw new Error("Playlist write has not been confirmed");
}
async function removeSong(song) {
  const rows = await playlistTracks();
  const matches = rows.filter(t => sameRecording(song,t));
  if (!matches.length) return true;
  const positions = matches.map(t => t.position);
  if (positions.some(p => !Number.isInteger(p) || p < 1)) throw new Error("Missing playlist position");
  await music("music/playlists/remove_playlist_tracks",{db_playlist_id:playlist,positions_to_remove:positions});
  for (const ms of [900,1800,3500,6000]) {
    await delay(ms);
    if (!(await playlistTracks()).some(t => sameRecording(song,t))) return true;
  }
  throw new Error("Playlist removal has not been confirmed");
}
async function processPending() {
  if (processing) return;
  processing = true;
  try {
    for (const song of [...pending]) {
      if (!pending.includes(song) || song.retryAt > Date.now()) continue;
      try {
        const completed = song.remove ? await removeSong(song) : await save(song);
        // A second tap can replace this request while MA is applying the first.
        const index = pending.indexOf(song);
        if (index < 0) continue;
        if (completed) {
          pending.splice(index,1);
          console.log(song.remove ? "Removed:" : "Saved:",song.artist,"—",song.title);
        } else {
          song.retryAt = Date.now() + 6*3600000;
          console.log("In playlist, waiting for a playable match:",song.artist,"—",song.title);
        }
      } catch (err) {
        song.retryAt = Date.now()+60000;
        console.warn("Retrying saved request:",song.artist,"—",song.title,err.message);
      }
      persist();
    }
  } finally { processing = false; }
  if (pending.some(song => !(song.retryAt > Date.now()))) void processPending();
}
async function capture(station) {
  const [recognition,...players] = await Promise.all([ options.recognition_sensor,...options.players ]
    .map(id => state(id).catch(() => null)));
  const song = playingSong(players,station,recognition?.attributes);
  if (!song) { console.log("Station heart changed without an identifiable song on the configured players."); return; }
  enqueue(station.favorite ? song : {...song,remove:true});
}
function enqueue(request) {
  const existing = pending.findIndex(s => sameRequest(s,request));
  if (existing >= 0) pending[existing] = request;
  else pending.push(request);
  persist();
  void processPending();
}
function sameRequest(a,b) {
  if (a.isrc && b.isrc) return songKey(a) === songKey(b);
  return songKey({...a,isrc:""}) === songKey({...b,isrc:""});
}
const stations = new Map();
const internal = new Map();
const lastDisplay = new Map();
const baselineFile = "/data/station-favorites.json";
const baselines = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile)) : {};
function persistBaselines() {
  writeFileSync(baselineFile+".tmp",JSON.stringify(baselines),{mode:0o600});
  renameSync(baselineFile+".tmp",baselineFile);
}
async function setHeart(station, wanted) {
  if (station.favorite === wanted) return;
  const uri = station.uri;
  const intent = {value:wanted,expires:Date.now()+15000};
  internal.set(uri,intent);
  try {
    if (wanted) await music("music/favorites/add_item",{item:uri});
    else await music("music/favorites/remove_item",{media_type:"radio",library_item_id:station.item_id});
  } catch (error) {
    if (internal.get(uri) === intent) internal.delete(uri);
    throw error;
  }
}
let prepared = false;
let reconciling = false;
let lastRefresh = 0;
let lastRecognition;

async function syncHearts() {
  if (!prepared || reconciling) return;
  reconciling = true;
  try {
    // The relay reads this same recognition before it sends the next ICY block.
    // Update the library flag before the kiosk resolves its new title's heart.
    const rec = (await state(options.recognition_sensor)).attributes;
    const song = rec.artist && rec.title ? {artist:rec.artist,title:rec.title,isrc:rec.isrc || ""} : null;
    const key = song ? songKey(song) : "";
    if (lastRecognition === key && Date.now()-lastRefresh < 5000) return;
    const players = await Promise.all(options.players.map(id => state(id).catch(() => null)));
    let rows;
    for (const [uri,station] of stations) {
      if (!stationPlayers(players,station).length) {
        if (Object.hasOwn(baselines,uri) && players.every(Boolean)) {
          await setHeart(station,baselines[uri]);
          delete baselines[uri];
          persistBaselines();
        }
        lastDisplay.delete(uri);
        continue;
      }
      if (lastDisplay.get(uri) === key) continue;
      if (!Object.hasOwn(baselines,uri)) {
        baselines[uri] = station.favorite;
        persistBaselines();
      }
      rows ??= await playlistTracks();
      const request = song && pending.find(p => sameRequest(p,song));
      const wanted = request ? !request.remove : Boolean(song && rows.some(t => sameRecording(song,t)));
      await setHeart(station,wanted);
      lastDisplay.set(uri,key);
    }
    lastRefresh = Date.now();
    lastRecognition = key;
  } catch (err) {
    console.warn("Heart synchronization:",err.message);
  } finally { reconciling = false; }
}
function connect() {
  const url = new URL("/ws", options.music_url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url);
  const previous = new Map();
  let deadline = setTimeout(() => ws.close(),12000);
  ws.addEventListener("open", () => ws.send(JSON.stringify({
    message_id:"authenticate",command:"auth",args:{token:options.music_token}
  })));
  ws.addEventListener("message", ({data}) => {
    const msg = JSON.parse(data);
    if (msg.message_id === "authenticate") {
      if (!msg.result?.authenticated) { console.error("Music Assistant authentication failed."); ws.close(); return; }
      for (const uri of options.station_uris) ws.send(JSON.stringify({
        message_id:"initial-"+uri,command:"music/item_by_uri",args:{uri}
      }));
      return;
    }
    if (msg.message_id?.startsWith("initial-")) {
      const station = msg.result;
      if (!station || typeof station.favorite !== "boolean") { ws.close(); return; }
      previous.set(station.uri,station.favorite);
      stations.set(station.uri,station);
      if (previous.size === options.station_uris.length) {
        clearTimeout(deadline);
        prepared = true;
        void syncHearts();
        console.log("Listening for radio hearts on",options.station_uris.join(", "));
      }
      return;
    }
    if (msg.event !== "media_item_updated" || !previous.has(msg.object_id)) return;
    const station = msg.data;
    if (typeof station?.favorite !== "boolean" || previous.get(msg.object_id) === station.favorite) return;
    previous.set(msg.object_id,station.favorite);
    stations.set(station.uri,station);
    const intent = internal.get(station.uri);
    internal.delete(station.uri);
    if (intent?.value === station.favorite && intent.expires > Date.now()) return;
    captureQueue = captureQueue.then(() => capture(station))
      .catch(err => console.error("Recording a heart failed:",err.message));
  });
  ws.addEventListener("error", () => ws.close());
  ws.addEventListener("close", () => {
    clearTimeout(deadline);
    prepared = false;
    stations.clear();
    internal.clear();
    lastDisplay.clear();
    lastRecognition = undefined;
    setTimeout(connect,3000);
  });
}
let captureQueue = Promise.resolve();
if (options.drive_bridge_key) {
  const widgetPush = widgetNotifications("/data", apnsSender("/data/drive-apns.json"));
  serveDrive(options.drive_bridge_key, driveHandler({state,playlistTracks,enqueue,widgetPush,recognitionSensor:options.recognition_sensor,
    fetchCover:(source, stillCurrent) => fetchDriveCover(source, stillCurrent, options.cover_entity),
    pending:song => pending.find(p => sameRequest(p,song)),historyFile:"/data/drive-history.json"}));
}
connect();
void processPending();
setInterval(processPending,30000).unref();
setInterval(syncHearts,1000).unref();
if (apple) {
  void refreshApple();
  setInterval(refreshApple,60000).unref();
}
