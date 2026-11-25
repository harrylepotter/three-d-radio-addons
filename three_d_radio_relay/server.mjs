import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { pipeline } from "node:stream/promises";
import { audioBytes, metadataInterval, taggedAudio } from "./icy.mjs";

const station = "https://sounds.threedradio.com/stream";
const ha = "http://supervisor/core/api";
const auth = { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}` };
const { public_url, recognition_sensor, cover_entity } = JSON.parse(readFileSync("/data/options.json", "utf8"));
const publicOrigin = new URL(public_url).origin;
const fallback = { title: "Three D Radio - Live broadcast", artwork: "" };
const covers = new Map();
let current = fallback;
let clients = 0;
let lastRefresh = 0;
let pendingRefresh;

async function haGet(path) {
  const response = await fetch(ha + path, { headers: auth, redirect: "error", signal: AbortSignal.timeout(4500) });
  if (!response.ok) throw new Error(`Home Assistant HTTP ${response.status}`);
  return response;
}

async function refresh() {
  const response = await haGet("/states/" + encodeURIComponent(recognition_sensor));
  const { state, attributes } = await response.json();
  lastRefresh = Date.now();
  if (["idle", "unknown", "unavailable"].includes(state) || !attributes.artist || !attributes.title) {
    current = fallback;
    return;
  }
  const title = `${attributes.artist} - ${attributes.title}`;
  let artwork = "";
  if (attributes.art_url) {
    const key = createHash("sha256").update(JSON.stringify([title, attributes.art_url])).digest("hex").slice(0, 24);
    const ext = /\.png(?:\?|$)/i.test(attributes.art_url) ? "png" : "jpg";
    const path = `/three-d/art/${key}.${ext}`;
    if (!covers.has(path)) {
      covers.set(path, { source: attributes.art_url });
      if (covers.size > 8) covers.delete(covers.keys().next().value);
    }
    artwork = publicOrigin + path;
  }
  if (current.title !== title || current.artwork !== artwork) current = { title, artwork };
}

function update() {
  if (!pendingRefresh) {
    pendingRefresh = refresh().catch(() => {
      if (Date.now() - lastRefresh > 30000) current = fallback;
    }).finally(() => { pendingRefresh = undefined; });
  }
  return pendingRefresh;
}

async function loadCover(entry, path) {
  // Fetch the exact matched release. HA's image entity also supports other art providers.
  const source = new URL(entry.source);
  let response;
  if (source.protocol === "https:" && source.hostname.endsWith(".mzstatic.com")) {
    try {
      response = await fetch(source, { redirect: "error", signal: AbortSignal.timeout(5000) });
    } catch { /* The HA image may already be cached. */ }
  }
  if (!response?.ok) {
    if (current.artwork !== publicOrigin + path) throw new Error("Cover expired");
    response = await haGet("/image_proxy/" + encodeURIComponent(cover_entity));
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 3 * 1024 * 1024) throw new Error("Cover too large");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const png = bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (!jpeg && !png) throw new Error("No cover image");
  return { bytes, type: jpeg ? "image/jpeg" : "image/png" };
}

async function serveCover(req, res, path, entry) {
  entry.loading ??= loadCover(entry, path).catch(error => { delete entry.loading; throw error; });
  const { bytes, type } = await entry.loading;
  res.writeHead(200, { "Content-Type": type, "Content-Length": bytes.length, "Cache-Control": "public, max-age=86400" });
  res.end(req.method === "HEAD" ? undefined : bytes);
}

async function serveRadio(req, res) {
  const tagged = req.headers["icy-metadata"] === "1";
  const headers = { "Content-Type": "audio/mpeg", "icy-name": "Three D Radio", "icy-br": "128",
    "Cache-Control": "no-store", ...(tagged && { "icy-metaint": metadataInterval }) };
  if (req.method === "HEAD") { res.writeHead(200, headers).end(); return; }
  clients++;
  void update();
  const controller = new AbortController();
  res.once("close", () => controller.abort());
  const deadline = setTimeout(() => controller.abort(), 10000);
  try {
    const upstream = await fetch(station, { headers: { "Icy-MetaData": "0" }, signal: controller.signal });
    clearTimeout(deadline);
    if (!upstream.ok || !upstream.headers.get("content-type")?.includes("audio/mpeg")) {
      throw new Error("Three D audio unavailable");
    }
    res.writeHead(200, headers);
    res.flushHeaders();
    const samples = audioBytes(upstream.body, Number(upstream.headers.get("icy-metaint")) || 0);
    await pipeline(tagged ? taggedAudio(samples, () => current) : samples, res, { signal: controller.signal });
  } finally {
    clearTimeout(deadline);
    controller.abort();
    clients--;
  }
}

setInterval(() => { if (clients) void update(); }, 4000).unref();
createServer(async (req, res) => {
  try {
    if (!["GET", "HEAD"].includes(req.method)) { res.writeHead(405, { Allow: "GET, HEAD" }).end(); return; }
    const path = (req.url || "").split("?")[0];
    if (path === "/three-d/stream") await serveRadio(req, res);
    else if (covers.has(path)) await serveCover(req, res, path, covers.get(path));
    else res.writeHead(404).end();
  } catch {
    if (res.destroyed) return;
    if (res.headersSent) res.destroy();
    else res.writeHead(502, { "Cache-Control": "no-store" }).end();
  }
}).listen(8753, "0.0.0.0");
