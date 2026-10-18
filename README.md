# signalk-ble-heater

Signal K plugin to **read and control** a Vevor-style BLE diesel heater (AirHeaterBLE protocol), with a touch web UI for KIP and Navico / B&G / Simrad MFDs.

- No MQTT, no Node-RED  
- PUT support for on/off, mode, temperature and power level  
- Web UI at `/signalk-ble-heater/` (keyword `signalk-webapp`)  
- Works with **signalk-navico-embedder** tiles  

## Install

From the Signal K App Store (once published), or:

```bash
cd ~/.signalk
npm install signalk-ble-heater
```

Enable **BLE Diesel Heater** under Server → Plugin Config. Set the heater MAC (and password if not `1234`).

**Important:** the heater accepts only one BLE connection. Close the phone AirHeaterBLE app before enabling the plugin.

## Config

| Field | Notes |
|-------|--------|
| id | Signal K id, e.g. `heater` → `electrical.heaters.heater.*` |
| zone | Cabin zone for `environment.inside.<zone>.temperature` (default `cabin`) |
| MAC | BLE address |
| password | Four digits, default `1234` |
| poll frequency | Seconds between status pings (default 15) |

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
