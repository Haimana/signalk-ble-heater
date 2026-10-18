/*
 * Copyright 2024-2026 SeB (sebba@end.ro) - S/V Haimana 264900475
 *
 * https://github.com/Haimana/signalk-ble-heater
 *
 * Reads and controls a Vevor-style BLE diesel heater from Signal K.
 * Protocol details and prior art:
 *   https://github.com/iotmaestro/vevor-heater-ble
 *   https://github.com/bderleta/vevor-ble-bridge
 *   https://github.com/spin877/Bruciatore_BLE
 *   https://github.com/htool/jbd-overkill-bms-plugin
 *
 * Many thanks to those developers.
 *
 * ---------------------------------------------------------------------
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict'

const protocol = require('./lib/protocol')
const { createSession } = require('./lib/heater')
const fuel = require('./lib/fuel')

const KELVIN_OFFSET = 273.15
const FUEL_SAVE_EVERY_MS = 60000

module.exports = function (app) {
  const plugin = {
    id: 'signalk-ble-heater',
    name: 'BLE Diesel Heater',
    description: 'Read and control a Vevor-style BLE diesel heater'
  }

  let session = null
  let deviceId = 'dieselHeater'
  let zone = 'cabin'
  let alarmState = null
  let pluginOptions = {}
  let fuelTracker = null
  let lastFuelSaveAt = 0
  let stickyFault = null
  let temperatureOffset = 0
  let autoStartStop = false
  let backlight = 5
  let syncSettingsOnConnect = false
  let startGeneration = 0
  let lastLink = null

  plugin.schema = {
    type: 'object',
    title: 'Heater settings',
    properties: {
      id: {
        type: 'string',
        title: 'Heater id',
        description: 'Used in electrical.heaters.<id>.*',
        default: 'dieselHeater'
      },
      zone: {
        type: 'string',
        title: 'Cabin zone name',
        description: 'Room temperature is published as environment.inside.<zone>.temperature',
        default: 'cabin'
      },
      MAC: {
        type: 'string',
        title: 'Heater BLE MAC address'
      },
      password: {
        type: 'string',
        title: 'Heater BLE password',
        description: 'Four digits, as used by the AirHeaterBLE app. Default for most units is 1234.',
        default: '1234'
      },
      pollFrequency: {
        type: 'number',
        title: 'Poll frequency in seconds',
        default: 15,
        minimum: 2
      },
      pumpType: {
        type: 'string',
        title: 'Fuel pump type',
        description: 'Volume per pump pulse (LCD F7 / cmd 17). Used to estimate diesel use.',
        default: '1',
        enum: ['0', '1', '2', '3'],
        enumNames: ['16 µL/pulse', '22 µL/pulse (common)', '28 µL/pulse', '32 µL/pulse']
      },
      tankSource: {
        type: 'string',
        title: 'Fuel tank',
        description:
          'Boat main tank = unlimited (no remaining estimate). Or pick a dedicated heater tank size (LCD F6).',
        default: 'main',
        enum: ['main', '5', '10', '15', '20', '25', '30', '35', '40', '45', '50'],
        enumNames: [
          'Boat main tank (unlimited)',
          'Separate 5 L',
          'Separate 10 L',
          'Separate 15 L',
          'Separate 20 L',
          'Separate 25 L',
          'Separate 30 L',
          'Separate 35 L',
          'Separate 40 L',
          'Separate 45 L',
          'Separate 50 L'
        ]
      },
      temperatureOffset: {
        type: 'number',
        title: 'Cabin temperature offset (°C)',
        description: 'LCD F5 / cmd 20. Positive raises the reading the heater uses.',
        default: 0,
        minimum: -9,
        maximum: 9
      },
      autoStartStop: {
        type: 'boolean',
        title: 'Automatic start/stop',
        description:
          'LCD F9 / cmd 18. In temperature mode the heater stops ~30s after reaching target and restarts 2°C below.',
        default: false
      },
      backlight: {
        type: 'number',
        title: 'Controller backlight',
        description: 'Cmd 21. 0 = off, typically 1–100.',
        default: 5,
        minimum: 0,
        maximum: 100
      },
      bleBackend: {
        type: 'string',
        title: 'BLE backend',
        description:
          'auto: use the Signal K BLE API (Data -> BLE Manager) when the server manages Bluetooth or already sees the heater, otherwise connect directly. server: always use app.bleApi (Signal K >= 2.31). direct: own node-ble/BlueZ connection (legacy). Never both at once.',
        default: 'auto',
        enum: ['auto', 'server', 'direct'],
        enumNames: ['Auto', 'Signal K BLE API (server / gateways)', 'Direct node-ble (legacy)']
      },
      serverWriteMode: {
        type: 'string',
        title: 'Write type in BLE API mode',
        description:
          'auto tries write-without-response first and switches once if the heater refuses or ignores it. Only change if the heater does not answer.',
        default: 'auto',
        enum: ['auto', 'without-response', 'with-response'],
        enumNames: ['Auto', 'Write without response', 'Write with response']
      },
      syncSettingsOnConnect: {
        type: 'boolean',
        title: 'Push settings to heater on connect',
        description:
          'Sends English, Celsius, metres, pump type, tank mode, offset, auto start/stop, backlight and clock.',
        default: false
      }
    }
  }

  function heaterPath(key) {
    return `electrical.heaters.${deviceId}.${key}`
  }

  // Schema uses string enums so the Signal K admin form accepts them. Legacy
  // separateTank / tankCapacityLiters configs are still honoured.
  function resolveTankSource(opts) {
    if (opts.tankSource === 'main' || opts.tankSource === 0 || opts.tankSource === '0') {
      return 'main'
    }
    if (opts.tankSource !== undefined && opts.tankSource !== null && opts.tankSource !== '') {
      const liters = fuel.litersFromTankIndex(fuel.tankIndexFromLiters(opts.tankSource))
      if (liters) {
        return String(liters)
      }
    }
    if (opts.separateTank === true) {
      const liters = fuel.litersFromTankIndex(fuel.tankIndexFromLiters(opts.tankCapacityLiters)) || 5
      return String(liters)
    }
    return 'main'
  }

  function applyTankSource(tracker, source) {
    if (!tracker) {
      return
    }
    if (source === 'main') {
      tracker.setSeparateTank(false)
    } else {
      tracker.setSeparateTank(true, Number(source))
    }
  }

  function toKelvin(celsius) {
    return celsius === null || celsius === undefined ? null : celsius + KELVIN_OFFSET
  }

  function litersToCubicMetres(liters) {
    return liters === null || liters === undefined ? null : liters / 1000
  }

  function sendDeltas(values, meta) {
    const update = { values }
    if (meta && meta.length) {
      update.meta = meta
    }
    app.handleMessage(plugin.id, { updates: [update] })
  }

  function publishMeta() {
    const label = deviceId
    sendDeltas([], [
      {
        path: heaterPath('state'),
        value: { description: 'Heater on/off', displayName: `${label} on/off` }
      },
      { path: heaterPath('powerStatus'), value: { description: 'off, running or error' } },
      {
        path: heaterPath('runningState'),
        value: { description: 'Standby, Self-test, Ignition, Running or Cooldown' }
      },
      {
        path: heaterPath('mode'),
        value: {
          description: 'Heater control mode',
          displayName: `${label} mode`,
          type: 'multiple',
          possibleValues: [
            { value: protocol.MODE.POWER_LEVEL, label: 'Power level', abbrev: 'Level' },
            { value: protocol.MODE.TEMPERATURE, label: 'Temperature', abbrev: 'Temp' }
          ]
        }
      },
      {
        path: heaterPath('targetTemperature'),
        value: { description: 'Target cabin temperature', displayName: `${label} target`, units: 'K' }
      },
      {
        path: heaterPath('powerLevel'),
        value: { description: 'Target power level, 1 to 10', displayName: `${label} level` }
      },
      {
        path: heaterPath('currentPowerLevel'),
        value: { description: 'Power level the heater is currently running at' }
      },
      { path: heaterPath('temperature'), value: { description: 'Combustion chamber temperature', units: 'K' } },
      {
        path: heaterPath('roomTemperature'),
        value: { description: 'Cabin temperature measured by the heater', units: 'K' }
      },
      { path: heaterPath('voltage'), value: { description: 'Supply voltage measured by the heater', units: 'V' } },
      { path: heaterPath('altitude'), value: { description: 'Altitude reported by the heater', units: 'm' } },
      { path: heaterPath('errorCode'), value: { description: 'Controller fault code (byte 4)' } },
      { path: heaterPath('displayErrorCode'), value: { description: 'Display fault code when present' } },
      { path: heaterPath('errorMessage'), value: { description: 'Decoded heater fault text, if any' } },
      { path: heaterPath('errorLabel'), value: { description: 'LCD-style fault label such as E02' } },
      {
        path: heaterPath('lastErrorMessage'),
        value: { description: 'Most recent fault text, kept after the heater clears it' }
      },
      { path: heaterPath('runningStepCode'), value: { description: 'Raw running-step byte 0-4' } },
      { path: heaterPath('powerStatusCode'), value: { description: 'Raw power-status byte 0-2' } },
      { path: heaterPath('frameLength'), value: { description: 'Last BLE status frame length in bytes' } },
      { path: heaterPath('protocolVariant'), value: { description: 'Protocol variant byte (usually 0x55)' } },
      {
        path: heaterPath('pumpType'),
        value: {
          description: 'Fuel pump type 0-3 (16/22/28/32 µL per pulse)',
          displayName: `${label} pump type`,
          type: 'multiple',
          possibleValues: [
            { value: 0, label: '16 µL/pulse', abbrev: '16' },
            { value: 1, label: '22 µL/pulse', abbrev: '22' },
            { value: 2, label: '28 µL/pulse', abbrev: '28' },
            { value: 3, label: '32 µL/pulse', abbrev: '32' }
          ]
        }
      },
      {
        path: heaterPath('separateTank'),
        value: {
          description: 'True when a dedicated heater tank is used; false draws from the boat main tank',
          displayName: `${label} separate tank`
        }
      },
      {
        path: heaterPath('tankCapacity'),
        value: { description: 'Separate heater tank capacity', units: 'm3' }
      },
      {
        path: heaterPath('fuelRemaining'),
        value: { description: 'Estimated fuel left in the separate tank, if any', units: 'm3' }
      },
      {
        path: heaterPath('fuelConsumedSinceRefuel'),
        value: { description: 'Estimated fuel used since last refuel reset', units: 'm3' }
      },
      { path: heaterPath('pumpPulseRate'), value: { description: 'Estimated fuel-pump pulse rate', units: 'Hz' } },
      {
        path: heaterPath('fuelRate'),
        value: { description: 'Estimated diesel consumption rate', units: 'm3/s' }
      },
      { path: heaterPath('fuelConsumed'), value: { description: 'Estimated diesel consumed since last total reset', units: 'm3' } },
      {
        path: heaterPath('fuelConsumedToday'),
        value: { description: 'Estimated diesel consumed today (UTC day)', units: 'm3' }
      },
      { path: heaterPath('pumpPulses'), value: { description: 'Estimated pump pulse count since last reset' } },
      {
        path: heaterPath('temperatureOffset'),
        value: { description: 'Cabin temperature compensation in °C', displayName: `${label} offset` }
      },
      {
        path: heaterPath('autoStartStop'),
        value: {
          description: 'Heater automatic start/stop around the temperature target',
          displayName: `${label} auto`
        }
      },
      {
        path: heaterPath('backlight'),
        value: { description: 'Controller backlight level 0-100', displayName: `${label} backlight` }
      },
      {
        path: heaterPath('refuel'),
        value: {
          description: 'PUT true after filling the separate tank to reset remaining fuel',
          displayName: `${label} refuel`
        }
      },
      {
        path: heaterPath('syncTime'),
        value: {
          description: 'PUT true to push the Signal K host clock to the heater',
          displayName: `${label} sync time`
        }
      },
      { path: heaterPath('ble.backend'), value: { description: 'BLE transport: server (Signal K BLE API) or direct (node-ble)' } },
      { path: heaterPath('ble.connectionState'), value: { description: 'BLE link state' } },
      { path: heaterPath('ble.provider'), value: { description: 'Signal K BLE provider that sees the heater (BLE API mode)' } },
      { path: heaterPath('ble.rssi'), value: { description: 'Last advertised signal strength', units: 'dBm' } },
      {
        path: `environment.inside.${zone}.temperature`,
        value: { description: 'Cabin temperature measured by the heater', units: 'K' }
      }
    ])
  }

  function publishLink(info) {
    const next = {
      backend: info.backend,
      connectionState: info.connectionState,
      provider: info.provider || null,
      rssi: typeof info.rssi === 'number' ? info.rssi : null
    }
    if (lastLink && Object.keys(next).every((k) => lastLink[k] === next[k])) {
      return
    }
    lastLink = next
    sendDeltas([
      { path: heaterPath('ble.backend'), value: next.backend },
      { path: heaterPath('ble.connectionState'), value: next.connectionState },
      { path: heaterPath('ble.provider'), value: next.provider },
      { path: heaterPath('ble.rssi'), value: next.rssi }
    ])
  }

  function bleApiUsable() {
    return Boolean(app.bleApi && typeof app.bleApi.subscribeGATT === 'function')
  }

  // Exactly one transport per start(); the old one is always stopped first.
  async function chooseBackend(opts) {
    const wanted = opts.bleBackend || 'auto'
    if (wanted === 'direct') {
      if (bleApiUsable() && app.bleApi.localBluetoothManaged) {
        app.debug('Direct node-ble mode while Signal K also manages Bluetooth; the heater will not show in BLE Manager')
      }
      return 'direct'
    }
    if (wanted === 'server') {
      if (!bleApiUsable()) {
        throw new Error(
          'Signal K BLE API (app.bleApi) is not available. It needs Signal K server 2.31 or newer; or set BLE backend to direct'
        )
      }
      return 'server'
    }
    if (!bleApiUsable()) {
      return 'direct'
    }
    if (app.bleApi.localBluetoothManaged) {
      return 'server'
    }
    // Not managing the local adapter, but a remote gateway may already see it.
    try {
      if (opts.MAC && typeof app.bleApi.getDevice === 'function' && (await app.bleApi.getDevice(String(opts.MAC).toUpperCase()))) {
        return 'server'
      }
    } catch (_e) {}
    return 'direct'
  }

  async function startSession(opts, pollSeconds, gen) {
    const backend = await chooseBackend(opts)
    if (gen !== startGeneration) {
      return
    }
    app.debug('BLE backend: %s', backend)
    const next = createSession(backend, {
      mac: opts.MAC,
      passkey: opts.password || '1234',
      pollInterval: pollSeconds * 1000,
      debug: app.debug,
      bleApi: app.bleApi,
      pluginId: plugin.id,
      writeMode: opts.serverWriteMode,
      backoffMin: opts._backoffMin
    })
    session = next

    next.on('status', publishStatus)
    next.on('link', publishLink)
    next.on('failure', (message) => {
      app.debug('BLE: %s', message)
      app.setPluginError(message)
    })
    next.on('connection', (state) => {
      if (state === 'connecting') {
        app.setPluginStatus(
          backend === 'server'
            ? `Connecting to heater ${opts.MAC} via Signal K BLE API`
            : `Connecting to heater ${opts.MAC}`
        )
      } else if (state === 'connected') {
        if (syncSettingsOnConnect) {
          pushSettingsToHeater().catch((err) => app.debug('Settings sync: %s', err.message))
        }
      } else if (state === 'reconnecting') {
        app.setPluginStatus('Heater disconnected, reconnecting. Is the AirHeaterBLE app connected?')
      }
    })
    next.start()
  }

  function publishFuel(snapshot) {
    sendDeltas([
      { path: heaterPath('pumpType'), value: snapshot.pumpType },
      { path: heaterPath('separateTank'), value: snapshot.separateTank },
      { path: heaterPath('tankCapacity'), value: litersToCubicMetres(snapshot.tankCapacityLiters) },
      { path: heaterPath('fuelRemaining'), value: litersToCubicMetres(snapshot.fuelRemaining) },
      {
        path: heaterPath('fuelConsumedSinceRefuel'),
        value: litersToCubicMetres(snapshot.fuelConsumedSinceRefuel)
      },
      { path: heaterPath('pumpPulseRate'), value: snapshot.pulseRate },
      { path: heaterPath('fuelRate'), value: litersToCubicMetres(snapshot.fuelRate) / 3600 },
      { path: heaterPath('fuelConsumed'), value: litersToCubicMetres(snapshot.fuelConsumed) },
      {
        path: heaterPath('fuelConsumedToday'),
        value: litersToCubicMetres(snapshot.fuelConsumedToday)
      },
      { path: heaterPath('pumpPulses'), value: Math.round(snapshot.pumpPulses) },
      { path: heaterPath('temperatureOffset'), value: temperatureOffset },
      { path: heaterPath('autoStartStop'), value: autoStartStop },
      { path: heaterPath('backlight'), value: backlight },
      { path: heaterPath('refuel'), value: false },
      { path: heaterPath('syncTime'), value: false }
    ])
  }

  function saveFuelState(force) {
    if (!fuelTracker) {
      return
    }
    const now = Date.now()
    if (!force && now - lastFuelSaveAt < FUEL_SAVE_EVERY_MS) {
      return
    }
    lastFuelSaveAt = now
    const snap = fuelTracker.persistable()
    // Only refresh fuel / tank / pump fields. Admin-form settings
    // (autoStartStop, syncSettingsOnConnect, …) stay as last loaded or PUT.
    // Forcing them from memory here races with Server → Plugin Config → Save.
    pluginOptions = Object.assign({}, pluginOptions, {
      totalLiters: snap.totalLiters,
      dailyLiters: snap.dailyLiters,
      dailyDate: snap.dailyDate,
      totalPulses: snap.totalPulses,
      consumedSinceRefuel: snap.consumedSinceRefuel,
      pumpType: String(snap.pumpType),
      tankSource: snap.separateTank ? String(snap.tankCapacityLiters) : 'main'
    })
    delete pluginOptions.separateTank
    delete pluginOptions.tankCapacityLiters
    delete pluginOptions.primeDuration
    delete pluginOptions.primeCommand
    app.savePluginOptions(pluginOptions, (err) => {
      if (err) {
        app.debug('Could not save plugin state: %s', err.message)
      }
    })
  }

  function publishStatus(status) {
    const live = !status.standby

    if (status.errorMessage) {
      stickyFault = {
        code: status.errorCode || status.displayErrorCode,
        message: status.errorMessage,
        at: Date.now()
      }
    } else if (status.runningStepCode === 3) {
      stickyFault = null
    }

    const lastErrorMessage = status.errorMessage || (stickyFault && stickyFault.message) || null

    sendDeltas([
      { path: heaterPath('state'), value: status.state },
      { path: heaterPath('powerStatus'), value: status.powerStatus },
      { path: heaterPath('runningState'), value: status.runningState },
      { path: heaterPath('mode'), value: status.mode },
      { path: heaterPath('targetTemperature'), value: toKelvin(status.targetTemperature) },
      { path: heaterPath('powerLevel'), value: status.powerLevel },
      { path: heaterPath('currentPowerLevel'), value: live ? status.currentPowerLevel : null },
      { path: heaterPath('temperature'), value: live ? toKelvin(status.chamberTemperature) : null },
      { path: heaterPath('voltage'), value: live ? status.voltage : null },
      { path: heaterPath('altitude'), value: live ? status.altitude : null },
      { path: heaterPath('errorCode'), value: status.errorCode },
      { path: heaterPath('displayErrorCode'), value: status.displayErrorCode },
      { path: heaterPath('errorMessage'), value: status.errorMessage },
      { path: heaterPath('errorLabel'), value: status.errorLabel },
      { path: heaterPath('lastErrorMessage'), value: lastErrorMessage },
      { path: heaterPath('runningStepCode'), value: status.runningStepCode },
      { path: heaterPath('powerStatusCode'), value: status.powerStatusCode },
      { path: heaterPath('frameLength'), value: status.frameLength },
      { path: heaterPath('protocolVariant'), value: status.variant },
      { path: heaterPath('roomTemperature'), value: toKelvin(status.roomTemperature) },
      { path: `environment.inside.${zone}.temperature`, value: toKelvin(status.roomTemperature) }
    ])

    if (fuelTracker) {
      publishFuel(fuelTracker.tick(status))
      saveFuelState(false)
    }

    publishAlarm(status)
    reportStatus(status, lastErrorMessage)
  }

  function publishAlarm(status) {
    const message = status.errorMessage
    const next = message || 'normal'
    if (next === alarmState) {
      return
    }
    alarmState = next
    sendDeltas([
      {
        path: `notifications.electrical.heaters.${deviceId}.error`,
        value: message
          ? { state: 'alarm', method: ['visual', 'sound'], message: `Heater: ${message}` }
          : { state: 'normal', method: [], message: 'No heater fault' }
      }
    ])
  }

  function reportStatus(status, faultMessage) {
    const parts = [status.runningState]
    if (faultMessage) {
      parts.push(`(${faultMessage})`)
    }
    if (status.mode === protocol.MODE.TEMPERATURE && status.targetTemperature !== null) {
      parts.push(`target ${status.targetTemperature}\u00b0C`)
    } else if (status.powerLevel !== null) {
      parts.push(`level ${status.powerLevel}`)
    }
    if (!status.standby) {
      parts.push(`cabin ${status.roomTemperature}\u00b0C`)
    }
    if (fuelTracker) {
      const snap = fuelTracker.snapshot()
      if (snap.fuelRate > 0) {
        parts.push(`${snap.fuelRate.toFixed(2)} L/h`)
      }
      if (snap.separateTank && snap.fuelRemaining !== null) {
        parts.push(`${snap.fuelRemaining.toFixed(1)} L left`)
      }
    }
    app.setPluginStatus(parts.join(' '))
  }

  async function pushSettingsToHeater() {
    if (!session || !session.connected || !fuelTracker) {
      return
    }
    const snap = fuelTracker.snapshot()
    const jobs = [
      [protocol.CMD.SET_LANGUAGE, protocol.LANGUAGE_ENGLISH],
      [protocol.CMD.SET_TEMP_UNIT, protocol.TEMP_UNIT_CELSIUS],
      [protocol.CMD.SET_ALTITUDE_UNIT, protocol.ALTITUDE_UNIT_METERS],
      [protocol.CMD.SET_PUMP_TYPE, snap.pumpType],
      [protocol.CMD.SET_TANK_VOLUME, snap.tankIndex],
      [protocol.CMD.SET_OFFSET, temperatureOffset],
      [protocol.CMD.SET_AUTO_START_STOP, autoStartStop ? 1 : 0],
      [protocol.CMD.SET_BACKLIGHT, backlight],
      [protocol.CMD.SYNC_TIME, protocol.encodeClockArgument()]
    ]
    for (const [cmd, value] of jobs) {
      try {
        await session.send(cmd, value)
      } catch (err) {
        app.debug('Settings sync cmd %s failed: %s', cmd, err.message)
      }
    }
  }

  plugin.start = function (options) {
    const opts = options || {}
    pluginOptions = Object.assign({}, opts)
    deviceId = opts.id || opts.heaterInstance || 'dieselHeater'
    zone = opts.zone || 'cabin'
    alarmState = null
    stickyFault = null
    temperatureOffset = Math.round(Number(opts.temperatureOffset) || 0)
    if (temperatureOffset < protocol.OFFSET_RANGE.min) {
      temperatureOffset = protocol.OFFSET_RANGE.min
    }
    if (temperatureOffset > protocol.OFFSET_RANGE.max) {
      temperatureOffset = protocol.OFFSET_RANGE.max
    }
    autoStartStop = opts.autoStartStop === true
    backlight = Math.round(Number(opts.backlight))
    if (!Number.isFinite(backlight)) {
      backlight = 5
    }
    backlight = Math.min(protocol.BACKLIGHT_RANGE.max, Math.max(protocol.BACKLIGHT_RANGE.min, backlight))
    // Explicit true only — an unchecked admin checkbox must stay off after Save.
    syncSettingsOnConnect = opts.syncSettingsOnConnect === true
    pluginOptions.autoStartStop = autoStartStop
    pluginOptions.syncSettingsOnConnect = syncSettingsOnConnect
    pluginOptions.temperatureOffset = temperatureOffset
    pluginOptions.backlight = backlight

    const tankSource = resolveTankSource(opts)
    fuelTracker = new fuel.FuelTracker({
      pumpType: opts.pumpType,
      separateTank: tankSource !== 'main',
      tankCapacityLiters: tankSource === 'main' ? null : Number(tankSource),
      totalLiters: opts.totalLiters,
      dailyLiters: opts.dailyLiters,
      dailyDate: opts.dailyDate,
      totalPulses: opts.totalPulses,
      consumedSinceRefuel: opts.consumedSinceRefuel
    })

    // Rewrite legacy tank fields into tankSource so the admin form validates.
    if (
      opts.tankSource !== tankSource ||
      Object.prototype.hasOwnProperty.call(opts, 'separateTank') ||
      Object.prototype.hasOwnProperty.call(opts, 'tankCapacityLiters') ||
      typeof opts.pumpType === 'number'
    ) {
      pluginOptions = Object.assign({}, opts, {
        tankSource,
        pumpType: String(fuel.normalizePumpType(opts.pumpType))
      })
      delete pluginOptions.separateTank
      delete pluginOptions.tankCapacityLiters
      delete pluginOptions.primeDuration
      delete pluginOptions.primeCommand
      app.savePluginOptions(pluginOptions, (err) => {
        if (err) {
          app.debug('Could not migrate tank options: %s', err.message)
        }
      })
    }

    if (!opts.id && opts.heaterInstance) {
      const migrated = Object.assign({}, pluginOptions, { id: deviceId })
      delete migrated.heaterInstance
      pluginOptions = migrated
      app.debug('Migrating heaterInstance "%s" to id', deviceId)
      app.savePluginOptions(migrated, (err) => {
        if (err) {
          app.debug('Could not save migrated options: %s', err.message)
        }
      })
    }

    const pollSeconds = Math.max(2, Number(opts.pollFrequency) || 15)
    const snap = fuelTracker.snapshot()
    app.debug(
      'Starting: heater %s, zone %s, MAC %s, poll %ds, pump %s, tank %s',
      deviceId,
      zone,
      opts.MAC,
      pollSeconds,
      snap.pumpLabel,
      snap.separateTank ? `${snap.tankCapacityLiters} L` : 'boat main (infinite)'
    )

    publishMeta()
    publishFuel(snap)
    registerPutHandlers()

    lastLink = null
    const gen = ++startGeneration
    startSession(opts, pollSeconds, gen).catch((err) => {
      if (gen === startGeneration) {
        app.setPluginError(err.message)
      }
    })
  }

  // Async so the server can wait for the GATT claim to be released; callers
  // that do not await still get a synchronous stop of polling and timers.
  plugin.stop = async function () {
    app.debug('Stopping')
    startGeneration++
    // Do not savePluginOptions here. Config Save stops the plugin right after
    // writing the form values; persisting stale in-memory flags would flip
    // unchecked boxes (auto start/stop, push settings) back on.
    const current = session
    session = null
    fuelTracker = null
    app.setPluginStatus('Stopped')
    if (current) {
      const done = current.stop()
      current.removeAllListeners()
      await done
    }
  }

  function putFailure(statusCode, message) {
    const err = new Error(message)
    err.statusCode = statusCode
    return err
  }

  function currentStatus() {
    return session ? session.lastStatus : null
  }

  function rawValue(value) {
    return value && typeof value === 'object' && 'value' in value ? value.value : value
  }

  function toBoolean(value) {
    const v = rawValue(value)
    if (typeof v === 'boolean') {
      return v
    }
    if (typeof v === 'number') {
      return v !== 0
    }
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase()
      if (['on', 'true', '1', 'yes'].includes(s)) {
        return true
      }
      if (['off', 'false', '0', 'no'].includes(s)) {
        return false
      }
    }
    return null
  }

  function requireSession() {
    if (!session || !session.connected) {
      throw putFailure(502, 'Heater is not connected over BLE')
    }
  }

  async function setMode(mode) {
    if (currentStatus() && currentStatus().mode === mode) {
      return
    }
    await session.send(protocol.CMD.MODE, mode)
  }

  async function putState(value) {
    const on = toBoolean(value)
    if (on === null) {
      throw putFailure(400, 'Expected true/false or on/off')
    }
    requireSession()
    const status = currentStatus()
    if (status && status.state === on) {
      return
    }
    if (on && status && !protocol.canStart(status)) {
      throw putFailure(409, `Heater cannot be started while it reports ${status.runningState}`)
    }
    if (!on && status && !protocol.canStop(status)) {
      throw putFailure(409, `Heater cannot be stopped while it reports ${status.runningState}`)
    }
    await session.send(protocol.CMD.POWER, on ? 1 : 0)
  }

  async function putMode(value) {
    const mode = Number(rawValue(value))
    if (mode !== protocol.MODE.POWER_LEVEL && mode !== protocol.MODE.TEMPERATURE) {
      throw putFailure(400, 'Expected 1 for power level or 2 for temperature')
    }
    requireSession()
    await session.send(protocol.CMD.MODE, mode)
  }

  async function putTargetTemperature(value) {
    let celsius = Number(rawValue(value))
    if (!Number.isFinite(celsius)) {
      throw putFailure(400, 'Expected a number')
    }
    if (celsius > 100) {
      celsius -= KELVIN_OFFSET
    }
    celsius = Math.round(celsius)
    const { min, max } = protocol.TEMPERATURE_RANGE
    if (celsius < min || celsius > max) {
      throw putFailure(400, `Target temperature must be ${min}-${max}\u00b0C, got ${celsius}\u00b0C`)
    }
    requireSession()
    const status = currentStatus()
    if (status && !protocol.canSetTarget(status)) {
      throw putFailure(409, `Heater ignores setpoints while it reports ${status.runningState}`)
    }
    await setMode(protocol.MODE.TEMPERATURE)
    await session.send(protocol.CMD.TARGET, celsius)
  }

  async function putPowerLevel(value) {
    const level = Math.round(Number(rawValue(value)))
    const { min, max } = protocol.POWER_LEVEL_RANGE
    if (!Number.isFinite(level) || level < min || level > max) {
      throw putFailure(400, `Power level must be ${min}-${max}, got ${value}`)
    }
    requireSession()
    const status = currentStatus()
    if (status && !protocol.canSetTarget(status)) {
      throw putFailure(409, `Heater ignores setpoints while it reports ${status.runningState}`)
    }
    await setMode(protocol.MODE.POWER_LEVEL)
    await session.send(protocol.CMD.TARGET, level)
  }

  async function putPumpType(value) {
    const raw = rawValue(value)
    const type = fuel.normalizePumpType(raw)
    if (!Number.isInteger(Number(raw)) || Number(raw) !== type) {
      throw putFailure(400, 'Pump type must be 0 (16µL), 1 (22µL), 2 (28µL) or 3 (32µL)')
    }
    if (fuelTracker) {
      fuelTracker.setPumpType(type)
      pluginOptions.pumpType = String(type)
      publishFuel(fuelTracker.snapshot())
      saveFuelState(true)
    }
    if (session && session.connected) {
      await session.send(protocol.CMD.SET_PUMP_TYPE, type)
    }
  }

  async function putSeparateTank(value) {
    const on = toBoolean(value)
    if (on === null) {
      throw putFailure(400, 'Expected true/false')
    }
    if (!fuelTracker) {
      return
    }
    const capacity = fuelTracker.tankCapacityLiters || Number(pluginOptions.tankSource) || 5
    applyTankSource(fuelTracker, on ? String(capacity) : 'main')
    pluginOptions.tankSource = on ? String(fuelTracker.tankCapacityLiters || 5) : 'main'
    publishFuel(fuelTracker.snapshot())
    saveFuelState(true)
    if (session && session.connected) {
      await session.send(protocol.CMD.SET_TANK_VOLUME, fuelTracker.heaterTankIndex())
    }
  }

  async function putTankCapacity(value) {
    let liters = Number(rawValue(value))
    if (!Number.isFinite(liters)) {
      throw putFailure(400, 'Expected tank capacity in litres or m³')
    }
    if (liters > 0 && liters < 1) {
      liters *= 1000
    }
    if (!fuelTracker) {
      return
    }
    applyTankSource(fuelTracker, String(fuel.litersFromTankIndex(fuel.tankIndexFromLiters(liters)) || 5))
    pluginOptions.tankSource = String(fuelTracker.tankCapacityLiters)
    publishFuel(fuelTracker.snapshot())
    saveFuelState(true)
    if (session && session.connected) {
      await session.send(protocol.CMD.SET_TANK_VOLUME, fuelTracker.heaterTankIndex())
    }
  }

  async function putTemperatureOffset(value) {
    const offset = Math.round(Number(rawValue(value)))
    if (!Number.isFinite(offset) || offset < protocol.OFFSET_RANGE.min || offset > protocol.OFFSET_RANGE.max) {
      throw putFailure(
        400,
        `Temperature offset must be ${protocol.OFFSET_RANGE.min} to ${protocol.OFFSET_RANGE.max} °C`
      )
    }
    temperatureOffset = offset
    pluginOptions.temperatureOffset = offset
    publishFuel(fuelTracker ? fuelTracker.snapshot() : {})
    saveFuelState(true)
    if (session && session.connected) {
      await session.send(protocol.CMD.SET_OFFSET, offset)
    }
  }

  async function putAutoStartStop(value) {
    const on = toBoolean(value)
    if (on === null) {
      throw putFailure(400, 'Expected true/false')
    }
    autoStartStop = on
    pluginOptions.autoStartStop = on
    publishFuel(fuelTracker ? fuelTracker.snapshot() : {})
    saveFuelState(true)
    if (session && session.connected) {
      await session.send(protocol.CMD.SET_AUTO_START_STOP, on ? 1 : 0)
    }
  }

  async function putBacklight(value) {
    const level = Math.round(Number(rawValue(value)))
    if (
      !Number.isFinite(level) ||
      level < protocol.BACKLIGHT_RANGE.min ||
      level > protocol.BACKLIGHT_RANGE.max
    ) {
      throw putFailure(400, 'Backlight must be 0-100')
    }
    backlight = level
    pluginOptions.backlight = level
    publishFuel(fuelTracker ? fuelTracker.snapshot() : {})
    saveFuelState(true)
    if (session && session.connected) {
      await session.send(protocol.CMD.SET_BACKLIGHT, level)
    }
  }

  async function putRefuel(value) {
    if (!toBoolean(value)) {
      return
    }
    if (!fuelTracker || !fuelTracker.separateTank) {
      throw putFailure(409, 'Refuel reset only applies to a separate heater tank')
    }
    fuelTracker.refuel()
    publishFuel(fuelTracker.snapshot())
    saveFuelState(true)
  }

  async function putSyncTime(value) {
    if (!toBoolean(value)) {
      return
    }
    requireSession()
    await session.send(protocol.CMD.SYNC_TIME, protocol.encodeClockArgument())
  }

  function registerPutHandlers() {
    const handlers = {
      state: putState,
      mode: putMode,
      targetTemperature: putTargetTemperature,
      powerLevel: putPowerLevel,
      pumpType: putPumpType,
      separateTank: putSeparateTank,
      tankCapacity: putTankCapacity,
      temperatureOffset: putTemperatureOffset,
      autoStartStop: putAutoStartStop,
      backlight: putBacklight,
      refuel: putRefuel,
      syncTime: putSyncTime
    }

    Object.keys(handlers).forEach((key) => {
      app.registerPutHandler(
        'vessels.self',
        heaterPath(key),
        (_context, _path, value, callback) => {
          Promise.resolve()
            .then(() => handlers[key](value))
            .then(() => callback({ state: 'COMPLETED', statusCode: 200 }))
            .catch((err) => {
              const statusCode = err.statusCode || (err.code === 'ETIMEDOUT' ? 504 : 502)
              app.debug('PUT %s failed: %s', key, err.message)
              callback({ state: 'COMPLETED', statusCode, message: err.message })
            })
          return { state: 'PENDING' }
        },
        plugin.id
      )
    })
  }

  return plugin
}
