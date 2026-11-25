import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

// The local playlist is authoritative for new likes. Keep a delivery history so a
// manual deletion in the Apple Music app survives later scans and HA restarts.
export function appleSync({sourceId, destinationUri, dataDir, music, sourceTracks, now = Date.now, wait = delay}) {
  const targetId = /^library:\/\/playlist\/(\d+)$/.exec(destinationUri)?.[1];
  if (!targetId || targetId === sourceId) throw new Error("Select a separate Apple Music library playlist");
  const file = dataDir + "/apple-delivery-" + sourceId + "-" + targetId + ".json";
  const history = existsSync(file) ? JSON.parse(readFileSync(file)) : {target:null, tracks:{}, queued:{}};
  history.jobs ??= {};
  function persist() {
    writeFileSync(file + ".tmp",JSON.stringify(history),{mode:0o600});
    renameSync(file + ".tmp",file);
  }
  const appleMappings = track => (track.provider_mappings || []).filter(m =>
    m.provider_domain === "apple_music" && m.available !== false && /^\d+$/.test(m.item_id));
  function remember(track) {
    for (const m of appleMappings(track)) {
      if (history.tracks[m.item_id] === "sent" || history.queued[m.item_id]) continue;
      history.queued[m.item_id] = {provider_instance:m.provider_instance,item_id:m.item_id};
      persist();
    }
  }
  function delivered(id) {
    history.tracks[id] = "sent";
    delete history.queued[id];
  }
  async function checkReceipts() {
    const active = new Set();
    for (const [jobId,ids] of Object.entries(history.jobs)) {
      if (ids.some(id => history.tracks[id] !== "sent")) {
        const job = await music("tasks/get",{task_id:jobId}).catch(() => null);
        if (job?.status === "success") ids.forEach(delivered);
        else if (job && ["pending","running","queued","waiting"].includes(job.status)) {
          ids.forEach(id => active.add(id));
          continue;
        } else if (!job && ids.some(id => history.tracks[id] > now())) continue;
      }
      delete history.jobs[jobId];
      persist();
    }
    return active;
  }
  let busy = false;
  async function sync() {
    if (busy) return;
    busy = true;
    try {
      // A successful append still counts if the owner immediately removed it
      // in Apple Music before our first read-back.
      const active = await checkReceipts();
      const local = await sourceTracks();
      const candidates = [...Object.values(history.queued), ...local.flatMap(appleMappings)]
        .filter(m => history.tracks[m.item_id] !== "sent" && !active.has(m.item_id));
      if (!candidates.length) return;
      const target = await music("music/item_by_uri",{uri:destinationUri});
      const map = target.provider_mappings?.[0];
      if (!target.is_editable || target.provider_mappings?.length !== 1 ||
          map.provider_domain !== "apple_music" || !/^p\./.test(map.item_id)) {
        throw new Error("The destination must be an editable Apple Music library playlist");
      }
      const identity = map.provider_instance + "://playlist/" + map.item_id;
      if (history.target && history.target !== identity) throw new Error("Apple Music playlist identity changed");
      history.target = identity;
      const ids = [...new Set(candidates.filter(m => m.provider_instance === map.provider_instance)
        .map(m => m.item_id))];
      if (!ids.length) return;
      async function remoteIds() {
        const remote = await music("music/playlists/playlist_tracks",{
          item_id:map.item_id, provider_instance_id_or_domain:map.provider_instance, force_refresh:true
        });
        return new Set(remote.flatMap(t => (t.provider_mappings || [])
          .filter(m => m.provider_instance === map.provider_instance).map(m => m.item_id)));
      }
      const present = await remoteIds();
      const fresh = [];
      const timestamp = now();
      let changed = false;
      for (const id of ids) {
        if (present.has(id)) {
          delivered(id);
          changed = true;
        } else if (!history.tracks[id] || timestamp >= history.tracks[id]) {
          // MA accepts the write as a background task and Apple can take time to
          // expose the result. Recheck membership before any retry, even on restart.
          history.tracks[id] = timestamp + 30 * 60 * 1000;
          fresh.push(id);
          changed = true;
        }
      }
      if (changed) persist();
      if (fresh.length) {
        const uris = fresh.map(id => map.provider_instance + "://track/" + id);
        const job = await music("music/playlists/add_playlist_tracks",{db_playlist_id:targetId,uris});
        if (job?.id) {
          history.jobs[job.id] = fresh;
          persist();
        }
        console.log("Submitted",fresh.length,"track(s) to the Apple Music playlist.");
        await wait(3000);
        const visible = await remoteIds();
        for (const id of fresh) {
          if (visible.has(id)) delivered(id);
        }
        persist();
      }
    } finally { busy = false; }
  }
  return {sync,remember};
}
