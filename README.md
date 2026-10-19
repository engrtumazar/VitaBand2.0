# VitaBand 2.0 IoT dashboard

The existing dashboard monitors device `VB-01` using Firebase Authentication and Realtime Database. Operator approval and profile management remain server-side. The browser only reads the device record; the ESP32 receiver submits validated readings to the Node.js API, which writes them with Firebase Admin SDK.

The supported data flow is:

`VitaBand sensors → LoRa → ESP32 receiver → HTTPS → Node.js ingestion API → Firebase Realtime Database → authenticated dashboard`

The software is prepared for hardware integration, but no physical receiver has been connected or verified. Until it submits actual readings, the dashboard shows an empty state.

## Run locally

Use Node.js 20.18 or newer. Install dependencies and create a private local `.env` file manually; this repository does not include an `.env.example` template:

```powershell
npm install
```

Edit `.env` with actual values. Keep `.env` and the Firebase service-account key out of source control. Store the key outside this project and point `GOOGLE_APPLICATION_CREDENTIALS` to its path. Generate a device token with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Set the generated token as `VITABAND_DEVICE_TOKEN` in `.env`. Set `VITABAND_ADMIN_EMAIL` to the exact Firebase Authentication email for the administrator. Start and test the app:

```powershell
npm test
npm start
```

Open <http://127.0.0.1:3000>. The default server binds to loopback and uses HTTP for local development only. It is not directly suitable for Internet or production hardware traffic.

## Firebase setup

The browser configuration in `frontend/firebase.js` is Firebase Web App configuration. Its API key is not a service-account credential; security depends on Firebase Authentication and database rules. Never place the Admin SDK service-account key or device token in frontend files.

1. Enable **Authentication → Sign-in method → Email/Password** in Firebase Console.
2. Create the administrator account. Add its UID at `approvedOperators/{uid}` with value `true`; set its email as `VITABAND_ADMIN_EMAIL`.
3. Create a Firebase service account for project `vitaband-d0f19`. Store its JSON key outside this project. Set `GOOGLE_APPLICATION_CREDENTIALS` to the full key path.
4. Publish the existing rules from [`database.rules.json`](database.rules.json). Approved users may read `devices/VB-01`; client writes to device data, operator requests, approvals, and profiles are denied. The trusted backend uses Admin SDK and validates device requests before writing.
5. Add the local or deployed dashboard hostname under **Authentication → Settings → Authorized domains**.

The backend does not seed, initialize, or clear Firebase records. Existing data remains at `devices/VB-01`.

## Deploy on Render with HTTPS

Render's Web Service provides the public HTTPS address and supplies the `PORT` environment variable. In production, the server binds to `0.0.0.0`; local development continues to bind to `127.0.0.1`.

1. Push the project and the latest changes to a GitHub repository you control. In Render, choose **New → Web Service**, connect that repository, and set the root directory to `.`, the build command to `npm install`, and the start command to `npm start`. Use Node.js 20.18 or newer.
2. In the Render service's **Environment** settings, add `NODE_ENV=production`, `VITABAND_ADMIN_EMAIL` (the administrator's Firebase Auth email), and `VITABAND_DEVICE_TOKEN` (a newly generated random token of at least 32 bytes). Do not put secrets in the repository or share them in chat.
3. Add the Firebase Admin service-account JSON as a Render **Secret File**, named `vitaband-service-account.json`, then set `GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/vitaband-service-account.json`. The service account must belong to `vitaband-d0f19`. Never commit this key.
4. Deploy the service. In Render, copy its public `https://...onrender.com` URL. Set `VITABAND_ALLOWED_ORIGIN` to that exact origin (scheme and hostname only, no trailing slash or path), then redeploy if Render requests it. Keep the device token private.
5. In Firebase Console, add the Render hostname under **Authentication → Settings → Authorized domains**. Publish the updated Realtime Database rules from [`database.rules.json`](database.rules.json).
6. Open the Render HTTPS URL and sign in with an approved account.

Confirm the deployment is using HTTPS and that `/api/config` returns the device configuration before testing sign-in. If the Render service sleeps on its selected plan, the first request after inactivity may take time to wake it.

## Device ingestion API

Submit one reading with:

- Method: `POST`
- Local path: `http://127.0.0.1:3000/api/device/readings`
- Production path: `https://<your-dashboard-host>/api/device/readings`
- Headers: `Content-Type: application/json` and `Authorization: Bearer <device-token>`

The API requires a random token of at least 32 bytes, rejects missing or invalid credentials, limits request bodies to 8 KB, and validates every field against the existing dashboard schema. The payload below is an illustrative JSONC template, not a directly executable request: its placeholders are explanatory text, not actual values. Replace each placeholder with a correctly typed value from the actual receiver. Do not send fabricated values during hardware integration.

```jsonc
// Illustrative only: replace every placeholder before submitting a request.
{
  "deviceId": "VB-01",
  "heartRateBpm": "<actual integer from 30 through 220>",
  "movementStatus": "<stationary | moving | unknown>",
  "gps": {
    "status": "<fix | no_fix>",
    "latitude": "<actual number, required when status is fix>",
    "longitude": "<actual number, required when status is fix>"
  },
  "loraStatus": "<receiving | disconnected>",
  "updatedAt": "<ISO 8601 timestamp with timezone>"
}
```

`gps.latitude` and `gps.longitude` must be numbers in valid geographic ranges when `gps.status` is `fix`; omit both when there is no fix. `updatedAt` may be an ISO 8601 timestamp with timezone or Unix milliseconds, and may not be more than 30 seconds in the future. The receiver must synchronize its clock. Unknown JSON fields, including client-supplied `history`, are rejected; the backend owns history creation.

When the wearable SOS button is pressed, include `"sosPressed": true` in that reading. Omit the field or send `false` for ordinary readings. The backend stores the received SOS event with server receipt time and preserves it across later readings; the dashboard displays a persistent **SOS RECEIVED** alert with the receipt time. A button event must use a unique `updatedAt` timestamp, like every other reading.

Responses:

- `201 { "status": "stored", "deviceId": "VB-01", "updatedAt": "..." }` for a new current reading.
- `201 { "status": "stored_historical", ... }` when a delayed reading is stored without replacing a newer current reading.
- `200 { "status": "duplicate", ... }` when an identical retry is recognized.
- `400` invalid JSON or payload; `401` missing/invalid bearer token; `409` timestamp collision with different data; `413` body over the limit; `415` unsupported content type; `503` ingestion not configured or Firebase unavailable.

The timestamp is the idempotency key because the hardware message ID has not been confirmed. The backend stores a hash of the normalized payload as server-generated history metadata; reusing a timestamp with different data is rejected. Timestamps therefore need millisecond precision and must not be reused for distinct readings.

The API writes the current record and history under `devices/VB-01`. The backend adds a server-generated `receivedAt` timestamp to each accepted reading and its history entry; it is not part of the device payload. The dashboard displays this next to the sensor's `updatedAt` timestamp so transfer delay can be compared. History entries use the sensor timestamp in milliseconds as their key and contain the timestamp, server receipt time, heart rate, and a backend-generated deduplication hash. At most the newest 1,000 history entries are retained by this endpoint. Firebase rules remain read-only for clients; no client-side database write permission is needed.

## Hardware connection procedure

1. Put the backend behind a TLS reverse proxy and expose the HTTPS hostname to the ESP32. Keep the Node server bound to `127.0.0.1` behind that proxy where possible. Do not send the bearer token over plain HTTP on an untrusted network or disable TLS certificate verification.
2. Configure the ESP32 with the HTTPS URL ending in `/api/device/readings` and the bearer token provisioned from `.env`. Do not commit or print the token. Use a protected device configuration store and a rotation process.
3. Map actual receiver fields to the payload above. Confirm the final heart-rate range/units, movement categories, GPS no-fix representation, LoRa status meanings, timestamp source/precision, device ID, and message cadence before enabling transmission.
4. Have the receiver POST one actual reading. Check for a `201` response, then inspect `devices/VB-01` in Firebase Console. The authenticated dashboard should update from its existing real-time Firebase listener.
5. Stop transmission and verify that the dashboard marks the last reading stale/offline after `DEVICE_STALE_AFTER_MS` (default `120000`). The timeout must be longer than the intended transmit interval and tolerated outages.

For local testing, the server binds to loopback by default and is not reachable from the ESP32. Exposing it to a LAN requires an intentionally configured host and network controls; use HTTPS for the bearer token. Production deployments also need `NODE_ENV=production` and `VITABAND_ALLOWED_ORIGIN` set to the exact dashboard origin for browser account-management requests.

## Device status and history

The device is **Online** only when its latest timestamp is within `DEVICE_STALE_AFTER_MS` and its last reported `loraStatus` is `receiving`. A fresh `disconnected` status is **Offline**; old data is **Offline / Stale**; no record is **Unknown**. Firebase connection status is displayed separately. The default freshness interval is 120 seconds and can be set from 1,000 to 86,400,000 milliseconds.

The dashboard charts only records under `devices/VB-01/history`; it does not convert the current reading into a historical point or create sample records. Invalid history items are skipped while valid current readings remain visible. Existing Firebase records are not changed during startup.

The live device map uses MapLibre GL JS with OpenFreeMap's Liberty vector style and OpenStreetMap data. It requires no map API key; map attribution is provided by the style. New GPS fixes update the device marker and the in-session movement trail.

### GPS location

The dashboard map and OLED use only the wearable's onboard GPS coordinates relayed to the backend by the base station. When the GPS module has no satellite fix, the dashboard shows GPS unavailable/waiting instead of substituting another location source. For a better fix, place the GPS antenna facing the sky and away from batteries, displays, and other electronics, then allow time for satellite acquisition outdoors.

## Operator accounts

Operators request an account from the login page. The backend creates it disabled, and only the configured administrator can approve or decline the pending request. Approved operators can read the device record and edit their profile. The backend verifies Firebase ID tokens for protected operator and administrator APIs. Browser sessions use Firebase Authentication session persistence.

## Verification and limitations

Run `npm test` for payload validation and HTTP authorization tests. These tests do not write to Firebase. Real Firebase reads/writes, admin approval, TLS deployment, and ESP32 submission require configured credentials and were not verified by the automated test suite. Do not claim hardware integration complete until a physical receiver has submitted a valid reading and the dashboard has displayed it.

The built-in server uses Node's HTTP module; production use requires a correctly configured HTTPS reverse proxy, firewall/network restrictions, protected secrets, and monitoring. This project currently supports the existing single device ID `VB-01`; adding devices requires an explicit schema and authorization update.
