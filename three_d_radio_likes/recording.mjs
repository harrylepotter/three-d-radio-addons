import { createHash } from "node:crypto";

const normalized = value => String(value || "").normalize("NFKD").toLowerCase()
  .replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]/gu, "");
export const songKey = song => song.isrc || JSON.stringify([normalized(song.artist), normalized(song.title)]);

// A manual library item can retain recognition metadata until a music provider
// supplies audio. The mapping belongs to this app and explicitly has no stream.
export function bookmark(song) {
  function mapping(fields) {
    const id = createHash("sha256").update(JSON.stringify(fields.map(normalized))).digest("hex");
    return {item_id:id,provider_domain:"three_d_radio_likes",provider_instance:"three_d_radio_likes",available:false};
  }
  const artist = mapping([song.artist]);
  const track = mapping([song.artist,song.title]);
  return {
    media_type:"track",provider:"builtin",item_id:track.item_id,name:song.title,provider_mappings:[track],
    artists:[{media_type:"artist",provider:artist.provider_instance,item_id:artist.item_id,name:song.artist,provider_mappings:[artist]}],
    external_ids:song.isrc ? [["isrc",song.isrc]] : [],
    metadata:{description:"Liked on Three D Radio. Waiting for a playable catalog match."}
  };
}

export function sameRecording(song, track) {
  const codes = (track.external_ids || []).filter(([type]) => type === "isrc")
    .map(([, code]) => normalized(code));
  if (song.isrc && codes.length) return codes.includes(normalized(song.isrc));
  if (!track.artists?.some(artist => normalized(artist.name) === normalized(song.artist))) return false;
  const name = normalized(track.name);
  const version = normalized(track.version);
  const full = version && !name.includes(version) ? name + version : name;
  return normalized(song.title) === full;
}

export function stationPlayers(states, station) {
  const sources = new Set([station.uri, ...station.provider_mappings.flatMap(m =>
    [m.item_id, m.provider_instance + "://radio/" + m.item_id, m.provider_domain + "://radio/" + m.item_id])]);
  return states.filter(s => s?.state === "playing" && sources.has(s.attributes.media_content_id));
}

export function playingSong(states, station, recognition) {
  const songs = stationPlayers(states,station)
    .map(s => ({artist: s.attributes.media_artist, title: s.attributes.media_title}))
    .filter(s => s.artist && s.title && normalized(s.artist) !== "threedradio");
  const matched = songs.find(s => normalized(s.artist) === normalized(recognition?.artist)
    && normalized(s.title) === normalized(recognition?.title));
  if (matched) return {...matched, isrc: recognition.isrc || ""};
  // Do not guess which song was liked if two buffered kiosks disagree at a boundary.
  if (songs.length && songs.every(s => songKey(s) === songKey(songs[0]))) return songs[0];
  return null;
}
