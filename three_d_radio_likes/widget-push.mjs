import { createPrivateKey, sign } from "node:crypto";
import { connect, sensitiveHeaders } from "node:http2";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const encoded = object => Buffer.from(JSON.stringify(object)).toString("base64url");

export function apnsSender(credentialsPath) {
  let session, authorization, topic, signedAt = 0;
  return async function send(token) {
    if (!existsSync(credentialsPath)) return {status: 0, reason: "AwaitingKey"};
    const now = Math.floor(Date.now() / 1000);
    if (!authorization || now - signedAt >= 40 * 60) {
      const {keyId, privateKey, teamId, bundleId} = JSON.parse(readFileSync(credentialsPath, "utf8"));
      if (!keyId || !privateKey || !teamId || !bundleId) throw new Error("Incomplete APNs sender configuration");
      topic = bundleId + ".push-type.widgets";
      const claims = encoded({alg:"ES256", kid:keyId}) + "." + encoded({iss:teamId, iat:now});
      const signature = sign("sha256", Buffer.from(claims), {key:createPrivateKey(privateKey), dsaEncoding:"ieee-p1363"});
      authorization = "bearer " + claims + "." + signature.toString("base64url");
      signedAt = now;
    }
    if (!session || session.closed || session.destroyed) {
      const connection = connect("https://api.sandbox.push.apple.com");
      connection.on("error", () => connection.destroy());
      connection.on("goaway", () => connection.close());
      session = connection;
    }
    return new Promise((resolve, reject) => {
      const req = session.request({
        ":method":"POST", ":path":"/3/device/" + token, authorization,
        "apns-topic":topic, "apns-push-type":"widgets", "apns-collapse-id":"three-d-now-playing",
        "apns-expiration":String(now + 150), [sensitiveHeaders]:[":path", "authorization"]
      }, {signal:AbortSignal.timeout(10000)});
      let status, body = "";
      req.on("response", headers => { status = headers[":status"]; });
      req.setEncoding("utf8");
      req.on("data", chunk => { body += chunk; });
      req.on("error", reject);
      req.on("end", () => {
        try { resolve({status, reason:body ? JSON.parse(body).reason : ""}); }
        catch (error) { reject(error); }
      });
      req.end(JSON.stringify({aps:{"content-changed":true}}));
    });
  };
}

// One paired iPhone. Keep the latest invalidation through restarts and coalesce
// further changes while APNs is busy. The phone fetches the current song from HA.
export function widgetNotifications(directory, send) {
  const file = join(directory, "drive-widget.json");
  const saved = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  let busy = false, timer, failures = 0, revision = 0;
  function persist() {
    writeFileSync(file + ".tmp", JSON.stringify(saved), {mode:0o600});
    renameSync(file + ".tmp", file);
  }
  function schedule(delay = 0) {
    if (timer || busy || !saved.pending || !saved.token) return;
    timer = setTimeout(flush, delay);
    timer.unref();
  }
  async function flush() {
    timer = undefined;
    busy = true;
    const token = saved.token, version = revision;
    try {
      const {status, reason} = await send(token);
      if (status === 200) {
        if (revision === version) saved.pending = false;
        failures = 0;
        saved.delivered = new Date().toISOString();
        console.log("Car widget update accepted by APNs");
      } else if (status === 410 && saved.token === token) {
        delete saved.token;
      } else {
        failures++;
        if (failures === 1) console.warn("Car widget update deferred:", status, reason);
      }
      persist();
    } catch (error) {
      if (++failures === 1) console.warn("Car widget transport unavailable:", error.code || error.name);
    } finally {
      busy = false;
      schedule(failures ? Math.min(300, 10 * 2 ** Math.min(5, failures - 1)) * 1000 : 0);
    }
  }
  schedule();
  return {
    register(token) {
      if (typeof token !== "string" || !/^(?:[a-f0-9]{2}){1,512}$/.test(token)) return false;
      if (saved.token !== token) {
        saved.token = token;
        revision++;
        persist();
      }
      schedule();
      return true;
    },
    changed() {
      revision++;
      saved.pending = true;
      persist();
      schedule();
    }
  };
}
