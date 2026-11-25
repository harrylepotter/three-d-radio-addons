# Three D Radio for Home Assistant

Identify songs on Adelaide’s Three D Radio stream, show them in Kiosk Satellite’s Now Playing view, and collect tracks in a Music Assistant playlist. The same backend serves the [Three D Drive iPhone app and CarPlay widget](https://github.com/harrylepotter/three-d-drive).

| Component | Function |
| --- | --- |
| `three_d_radio_relay/` | Forwards the station audio with ICY metadata for the matched song and serves its cover art. |
| `three_d_radio_likes/` | Maps a radio-station heart to the identified recording, updates the heart on track changes, and queues playlist writes. |
| `blueprints/` | Turns the stream recognizer on while a configured player is tuned in or a drive is active. |
| `packages/` | Provides the drive timer, app actions and widget updates. An optional package adds a Home Assistant Companion Live Activity. |

## Kiosk playback and recognition

1. Install scrobSter and configure a URL-based source using Three D’s stream at `https://sounds.threedradio.com/stream`. Set the match interval to about 60 seconds and enable its Home Assistant entities. Note the recognition switch, now-playing sensor and image entity. [scrobSter](https://github.com/benkelly/scrobSter)
2. Copy the two add-on directories into your local Home Assistant add-ons directory, reload the add-on store, then install the relay and playlist add-ons. The relay needs a LAN address reachable by the players. Set `public_url` to its origin including the exposed port (default 8753). Set `recognition_sensor` and `cover_entity` to your scrobSter entities in **both** add-ons.
3. Start the relay and add `/three-d/stream` at its public origin as a custom radio station in Music Assistant. Play this station on each kiosk. Use a separate Music Assistant station entry per kiosk if those players need independent heart state.
4. In Music Assistant, create a local playlist named **liked from 3d radio**. In the playlist add-on options set `music_url`, `music_token`, `playlist_uri`, the list of `station_uris`, and the HA media-player entities in `players`. Use the library URIs for the playlist and radio station entries. Start the add-on.
5. Copy the supplied blueprint to the corresponding directory under `config/blueprints/`, reload automations, and create an automation from **Three D Radio recognition while listening**. Select your players and recognition switch and provide the media content IDs they report for this station, including any library URIs and relay URL. The drive timer input defaults to the timer defined by the drive package. Kiosk-only setups can use the blueprint without installing that package.

## Apple Music

Create or select an editable Apple Music playlist in Music Assistant and add it to the Music Assistant library. Enter its library URI as `apple_playlist_uri` in the playlist add-on. This destination must be separate from the local likes playlist. New likes are copied when Music Assistant has a playable Apple Music match. Manual deletions in Apple Music are respected. Unmatched tracks remain bookmarked locally and are retried.

## CarPlay

1. Copy `packages/three_d_drive.yaml` to your Home Assistant packages directory and enable packages in your configuration. In that **local copy**, replace the example sensor `sensor.radio_stream_match` with your scrobSter sensor, or assign your sensor that entity ID. The sensor provides `artist`, `title`, `ts` (Unix seconds), and optionally `isrc` and `art_url`.
2. Set a random `drive_bridge_key` in the playlist add-on. In your own HA secrets, set `three_d_drive_authorization` to `Bearer ` followed by that key. Set `three_d_drive_bridge_url` to the add-on’s internal HTTP origin on port 8754 with path `/drive`. Find its hostname on the add-on Info tab. Restart the add-on and load the package.
3. For server-triggered widget updates, enable Push Notifications for the iOS targets and create a sandbox APNs signing key restricted to the app’s topic. In the playlist add-on’s persistent `/data/drive-apns.json` file, set the string fields `teamId`, `bundleId` (the **app** identifier), `keyId` and `privateKey` (PEM). Restrict file access to the add-on owner. The provider reads the key locally and sends a content-change signal to Apple. The widget fetches artwork and track details directly from your server.
4. Install the [iPhone app](https://github.com/harrylepotter/three-d-drive) and add its CarPlay widget. The widget registers automatically when iOS activates it. A drive starts from the app or widget and ends through the app, a CarPlay disconnect automation, or the two-hour timer.

For an additional text-only Companion Live Activity, install `packages/optional/companion_activity.yaml` alongside the main package and set `three_d_drive_notify_action` in your local secrets to your phone’s Companion notification action.

## Kiosk announcements

Kiosk Satellite also exposes display notifications and spoken announcements through its ESPHome connection. Select the target kiosk’s **announce** action in Home Assistant and enter a message for speech and an onscreen card. Its **notification** action shows a card with a configurable timeout. [Kiosk Satellite notification and announcement actions](https://kiosksatellite.com/docs/esphome/#announcements)

## Tests

Run `node --test tests/*.test.mjs` with Node.js 22 or later. The tests cover ICY audio framing, track changes and stale hearts, Apple Music delivery and manual removal, and coalescing widget updates across restarts.
