# signalk-ble-heater

Signal K plugin to **read and control** a Vevor-style BLE diesel heater (AirHeaterBLE protocol), with a touch web UI for KIP and Navico / B&G / Simrad MFDs.

- No MQTT, no Node-RED  
- PUT support for on/off, mode, temperature and power level  
- Web UI at `/signalk-ble-heater/` (keyword `signalk-webapp`)  
- Works with **signalk-navico-embedder** tiles  
- Uses the **Signal K BLE API** (server ≥ 2.31): shows up in **Data → BLE Manager**, shares the adapter with other BLE plugins, and can reach the heater through a remote ESP32 BLE gateway. Falls back to its own node-ble connection on older servers.

## Install

From the Signal K App Store (once published), or:

```bash
cd ~/.signalk
npm install signalk-ble-heater
```

Enable **BLE Diesel Heater** under Server → Plugin Config. Set the heater MAC (and password if not `1234`).

**Important:** the heater accepts only one BLE connection. Close the phone AirHeaterBLE app before enabling the plugin.

## BLE backend (Signal K BLE Manager)

Signal K server 2.31 and newer has a built-in BLE API (`app.bleApi`). In that mode the server owns the Bluetooth adapter (or a remote gateway), this plugin asks it for a GATT subscription to the heater (service `FFE0`, notify + write on `FFE1`), and the connection appears in **Data → BLE Manager** as a consumer holding the GATT claim for the heater's MAC.

To use it:

1. Signal K server **2.31 or newer**.
2. **Server → Settings → Bluetooth**: enable server-managed local Bluetooth (`localBluetoothManaged`), or connect a remote BLE gateway that supports GATT over the gateway WebSocket (e.g. SensESP BLE gateway firmware). Advertisement-only gateways cannot drive the heater.
3. Disable any other plugin that opens the same adapter directly with node-ble / BlueZ (for example `bt-sensors-plugin-sk` in direct mode), or make sure it does not try to connect to the heater. The heater accepts **one** BLE connection.
4. Leave **BLE backend** on `auto` (or set `server`).

`auto` picks the BLE API when `app.bleApi` exists and either the server manages local Bluetooth or a provider already sees the heater's MAC; otherwise it uses the direct node-ble connection. `server` forces the BLE API (plugin error if unavailable), `direct` forces the legacy node-ble connection. The two are never active at the same time.

Diagnostics (`/signalk-ble-heater/diagnostics.html`) and the paths `electrical.heaters.<id>.ble.backend`, `.ble.connectionState`, `.ble.provider`, `.ble.rssi` show which transport and provider are in use.

Write type: the server's local provider maps "write with response" to a BlueZ *reliable* write, which this heater refuses, so the plugin writes without response by default and switches once if the heater refuses or never answers (`serverWriteMode`: `auto` / `without-response` / `with-response`).

Stale links: if a previous Signal K process (or anything else) left the heater connected in BlueZ, the heater stops advertising and no provider sees it. With `releaseStaleLink` on (default), the plugin checks BlueZ once at startup and again whenever the heater is not seen within the wait window; if `org.bluez.Device1.Connected` is true and no plugin holds a GATT claim on the MAC, it calls `Device1.Disconnect()` (D-Bus, fallback `bluetoothctl disconnect`) and keeps waiting. A link claimed by another plugin is never touched; a leftover claim of this plugin itself is released through `app.bleApi.releaseGATTDevice`. At most one release every 30 s.

## Config

| Field | Notes |
|-------|--------|
| id | Signal K id, e.g. `heater` → `electrical.heaters.heater.*` |
| zone | Cabin zone for `environment.inside.<zone>.temperature` (default `cabin`) |
| MAC | BLE address |
| password | Four digits, default `1234` |
| poll frequency | Seconds between status pings (default 15) |
| bleBackend | `auto` (default), `server` (Signal K BLE API), `direct` (own node-ble connection) |
| releaseStaleLink | BLE API mode: disconnect an orphaned BlueZ link nobody claims (default on) |
| serverWriteMode | BLE API mode write type: `auto` (default), `without-response`, `with-response` |

## Paths

| Path | Type | PUT |
|------|------|-----|
| `electrical.heaters.<id>.state` | boolean | yes |
| `electrical.heaters.<id>.powerStatus` | string (`off` / `running` / `error`) | no |
| `electrical.heaters.<id>.runningState` | string | no |
| `electrical.heaters.<id>.mode` | 1 = power level, 2 = temperature | yes |
| `electrical.heaters.<id>.targetTemperature` | K (8–36 °C) | yes |
| `electrical.heaters.<id>.powerLevel` | 1–10 | yes |
| `electrical.heaters.<id>.currentPowerLevel` | 1–10 | no |
| `electrical.heaters.<id>.temperature` | K (combustion chamber) | no |
| `electrical.heaters.<id>.roomTemperature` | K | no |
| `electrical.heaters.<id>.voltage` | V | no |
| `electrical.heaters.<id>.altitude` | m | no |
| `electrical.heaters.<id>.errorCode` / `.displayErrorCode` | number | no |
| `environment.inside.<zone>.temperature` | K | no |
| `notifications.electrical.heaters.<id>.error` | alarm | no |

Setting `targetTemperature` or `powerLevel` automatically switches mode first.

Commands the heater would ignore (e.g. stop while cooling down) return HTTP **409** with a clear message instead of failing silently.

## KIP

- Switch Panel → Toggle → `self.electrical.heaters.<id>.state`  
- Multi State Switch → `self.electrical.heaters.<id>.mode`  
- Numeric → `targetTemperature` or `powerLevel`  
- Indicator → `runningState`  

Use the `self.` prefix. Hard-refresh KIP after enabling the plugin.

## Navico / Zeus

1. Open `/signalk-ble-heater/` in a browser to confirm the UI.  
2. In **signalk-navico-embedder** → Discover / enable the tile for `/signalk-ble-heater/`.  
3. Ensure the embedder JWT (`skToken`) is set if Signal K auth is on.

## Protocol notes

GATT service `FFE0`, characteristic `FFE1`. Request: `AA [variant] [pwd_hi] [pwd_lo] [cmd] [val_lo] [val_hi] [checksum]`.

This heater answers with **18-byte** status frames when idle (checksum at offset 17) and may use the longer 20-byte layout documented by iotmaestro when running. Both are accepted.

## Development

```bash
npm test
```

## Credits

Protocol and prior art:

- [iotmaestro/vevor-heater-ble](https://github.com/iotmaestro/vevor-heater-ble)  
- [bderleta/vevor-ble-bridge](https://github.com/bderleta/vevor-ble-bridge)  
- [spin877/Bruciatore_BLE](https://github.com/spin877/Bruciatore_BLE)  
- [htool/jbd-overkill-bms-plugin](https://github.com/htool/jbd-overkill-bms-plugin) (BLE session / reconnect pattern)  

## License

Apache-2.0 — SeB / S/V Haimana
