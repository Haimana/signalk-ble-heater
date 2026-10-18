'use strict'

const test = require('node:test')
const assert = require('node:assert')
const protocol = require('../lib/protocol')
const { FakeHeater, installFakeBluetooth } = require('./fake-heater')

function createApp() {
  const app = {
    deltas: [],
    putHandlers: {},
    status: null,
    error: null,
    debug: () => {},
    handleMessage: (_id, message) => app.deltas.push(message),
    setPluginStatus: (text) => {
      app.status = text
    },
    setPluginError: (text) => {
      app.error = text
    },
    registerPutHandler: (_context, path, handler) => {
      app.putHandlers[path] = handler
    },
    savedOptions: null,
    savePluginOptions: (configuration, cb) => {
      app.savedOptions = configuration
      if (cb) {
        cb()
      }
    }
  }
  return app
}

function latestValue(app, path) {
  let found
  app.deltas.forEach((message) => {
    message.updates.forEach((update) => {
      ;(update.values || []).forEach((entry) => {
        if (entry.path === path) {
          found = entry.value
        }
      })
    })
  })
  return found
}

function metaFor(app, path) {
  let found
  app.deltas.forEach((message) => {
    message.updates.forEach((update) => {
      ;(update.meta || []).forEach((entry) => {
        if (entry.path === path) {
          found = entry.value
        }
      })
    })
  })
  return found
}

function put(app, path, value) {
  return new Promise((resolve) => {
    const immediate = app.putHandlers[path](null, path, value, resolve)
    if (immediate && immediate.state !== 'PENDING') {
      resolve(immediate)
    }
  })
}

async function waitFor(predicate, label, timeout = 2000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function startPlugin(initialHeaterState) {
  const heater = new FakeHeater(initialHeaterState)
  const fake = installFakeBluetooth(heater)
  delete require.cache[require.resolve('../index.js')]
  const app = createApp()
  const plugin = require('../index.js')(app)
  plugin.start({ id: 'cabinHeater', zone: 'saloon', MAC: 'AA:BB:CC:DD:EE:FF', password: '1234', pollFrequency: 2 })
  await waitFor(
    () => latestValue(app, 'electrical.heaters.cabinHeater.runningState') !== undefined,
    'first status delta'
  )
  return { app, plugin, heater, characteristic: fake.device.characteristic }
}

test('publishes heater state and cabin temperature on the configured paths', async () => {
  const { plugin, app } = await startPlugin({ roomTemperature: 19, powerStatus: 0, runningStep: 0 })
  try {
    assert.strictEqual(latestValue(app, 'electrical.heaters.cabinHeater.state'), false)
    assert.strictEqual(latestValue(app, 'electrical.heaters.cabinHeater.powerStatus'), 'off')
    assert.strictEqual(latestValue(app, 'electrical.heaters.cabinHeater.runningState'), 'Standby')
    assert.ok(Math.abs(latestValue(app, 'environment.inside.saloon.temperature') - 292.15) < 0.001)
  } finally {
    plugin.stop()
  }
})

test('telemetry is cleared in standby instead of left frozen', async () => {
  const { plugin, app } = await startPlugin({ runningStep: 0, powerStatus: 0 })
  try {
    assert.strictEqual(latestValue(app, 'electrical.heaters.cabinHeater.voltage'), null)
    assert.strictEqual(latestValue(app, 'electrical.heaters.cabinHeater.temperature'), null)
    assert.strictEqual(latestValue(app, 'electrical.heaters.cabinHeater.altitude'), null)
  } finally {
    plugin.stop()
  }
})

test('state carries no units so KIP treats it as boolean', async () => {
  const { plugin, app } = await startPlugin()
  try {
    const stateMeta = metaFor(app, 'electrical.heaters.cabinHeater.state')
    assert.ok(stateMeta)
    assert.strictEqual(stateMeta.units, undefined)
  } finally {
    plugin.stop()
  }
})

test('mode is advertised for the multi state switch widget', async () => {
  const { plugin, app } = await startPlugin()
  try {
    const modeMeta = metaFor(app, 'electrical.heaters.cabinHeater.mode')
    assert.strictEqual(modeMeta.type, 'multiple')
    assert.deepStrictEqual(
      modeMeta.possibleValues.map((v) => v.value),
      [protocol.MODE.POWER_LEVEL, protocol.MODE.TEMPERATURE]
    )
  } finally {
    plugin.stop()
  }
})

test('PUT handlers are registered for control and settings paths', async () => {
  const { plugin, app } = await startPlugin()
  try {
    assert.deepStrictEqual(Object.keys(app.putHandlers).sort(), [
      'electrical.heaters.cabinHeater.autoStartStop',
      'electrical.heaters.cabinHeater.backlight',
      'electrical.heaters.cabinHeater.mode',
      'electrical.heaters.cabinHeater.powerLevel',
      'electrical.heaters.cabinHeater.pumpType',
      'electrical.heaters.cabinHeater.refuel',
      'electrical.heaters.cabinHeater.separateTank',
      'electrical.heaters.cabinHeater.state',
      'electrical.heaters.cabinHeater.syncTime',
      'electrical.heaters.cabinHeater.tankCapacity',
      'electrical.heaters.cabinHeater.targetTemperature',
      'electrical.heaters.cabinHeater.temperatureOffset'
    ])
  } finally {
    plugin.stop()
  }
})

test('turning the heater on reaches the device and comes back confirmed', async () => {
  const { plugin, app, heater } = await startPlugin({ powerStatus: 0, runningStep: 0 })
  try {
    const result = await put(app, 'electrical.heaters.cabinHeater.state', true)
    assert.strictEqual(result.statusCode, 200)
    assert.ok(heater.commands.some((c) => c.cmd === protocol.CMD.POWER && c.value === 1))
    assert.strictEqual(latestValue(app, 'electrical.heaters.cabinHeater.state'), true)
  } finally {
    plugin.stop()
  }
})

test('setting a target temperature switches the heater into temperature mode first', async () => {
  const { plugin, app, heater } = await startPlugin({ mode: protocol.MODE.POWER_LEVEL, target: 5 })
  try {
    const result = await put(app, 'electrical.heaters.cabinHeater.targetTemperature', 295.15)
    assert.strictEqual(result.statusCode, 200)

    const modeCommand = heater.commands.findIndex(
      (c) => c.cmd === protocol.CMD.MODE && c.value === protocol.MODE.TEMPERATURE
    )
    const targetCommand = heater.commands.findIndex((c) => c.cmd === protocol.CMD.TARGET && c.value === 22)
    assert.ok(modeCommand >= 0, 'mode command was sent')
    assert.ok(targetCommand > modeCommand, 'mode is switched before the setpoint')
    assert.strictEqual(heater.state.mode, protocol.MODE.TEMPERATURE)
    assert.strictEqual(heater.state.target, 22)
  } finally {
    plugin.stop()
  }
})

test('a Celsius value is accepted where Kelvin is expected', async () => {
  const { plugin, app, heater } = await startPlugin()
  try {
    const result = await put(app, 'electrical.heaters.cabinHeater.targetTemperature', 24)
    assert.strictEqual(result.statusCode, 200)
    assert.strictEqual(heater.state.target, 24)
  } finally {
    plugin.stop()
  }
})

test('setting a power level switches into level mode first', async () => {
  const { plugin, app, heater } = await startPlugin({ mode: protocol.MODE.TEMPERATURE })
  try {
    const result = await put(app, 'electrical.heaters.cabinHeater.powerLevel', 7)
    assert.strictEqual(result.statusCode, 200)
    assert.strictEqual(heater.state.mode, protocol.MODE.POWER_LEVEL)
    assert.strictEqual(heater.state.target, 7)
  } finally {
    plugin.stop()
  }
})

test('out of range setpoints are refused before touching the heater', async () => {
  const { plugin, app, heater } = await startPlugin()
  try {
    const before = heater.commands.length
    const level = await put(app, 'electrical.heaters.cabinHeater.powerLevel', 99)
    assert.strictEqual(level.statusCode, 400)

    const temp = await put(app, 'electrical.heaters.cabinHeater.targetTemperature', 50)
    assert.strictEqual(temp.statusCode, 400)

    const mode = await put(app, 'electrical.heaters.cabinHeater.mode', 9)
    assert.strictEqual(mode.statusCode, 400)

    assert.strictEqual(heater.commands.length, before, 'nothing was sent to the heater')
  } finally {
    plugin.stop()
  }
})

// The real heater silently ignores a stop request while it cools down.
test('commands the heater would ignore are refused with 409', async () => {
  const { plugin, app, heater } = await startPlugin({ powerStatus: 1, runningStep: 4 })
  try {
    const stop = await put(app, 'electrical.heaters.cabinHeater.state', false)
    assert.strictEqual(stop.statusCode, 409)
    assert.match(stop.message, /Cooldown/)

    const target = await put(app, 'electrical.heaters.cabinHeater.targetTemperature', 295.15)
    assert.strictEqual(target.statusCode, 409)

    assert.ok(!heater.commands.some((c) => c.cmd === protocol.CMD.POWER))
  } finally {
    plugin.stop()
  }
})

test('asking for the state the heater already has is a no-op', async () => {
  const { plugin, app, heater } = await startPlugin({ powerStatus: 1, runningStep: 3 })
  try {
    const result = await put(app, 'electrical.heaters.cabinHeater.state', true)
    assert.strictEqual(result.statusCode, 200)
    assert.ok(!heater.commands.some((c) => c.cmd === protocol.CMD.POWER))
  } finally {
    plugin.stop()
  }
})

test('a heater that stops answering reports a timeout rather than hanging', async () => {
  const { plugin, app, heater } = await startPlugin()
  try {
    heater.silent = true
    const result = await put(app, 'electrical.heaters.cabinHeater.state', true)
    assert.strictEqual(result.statusCode, 504)
  } finally {
    heater.silent = false
    plugin.stop()
  }
})

// The real unit rejects BlueZ "reliable" writes; node-ble falls back to a plain
// ATT write request, then to write-without-response if that is also refused.
test('falls back to write without response when write-with-response is refused', async () => {
  const { plugin, app, heater, characteristic } = await startPlugin({ powerStatus: 0, runningStep: 0 })
  try {
    heater.refuseWriteWithResponse = true
    const result = await put(app, 'electrical.heaters.cabinHeater.state', true)
    assert.strictEqual(result.statusCode, 200)
    assert.ok(characteristic.writes.includes('command'))
    assert.strictEqual(latestValue(app, 'electrical.heaters.cabinHeater.state'), true)
  } finally {
    plugin.stop()
  }
})

test('the old heaterInstance setting still selects the path', async () => {
  const heater = new FakeHeater()
  installFakeBluetooth(heater)
  delete require.cache[require.resolve('../index.js')]
  const app = createApp()
  const plugin = require('../index.js')(app)
  plugin.start({ heaterInstance: 'heater', MAC: 'AA:BB:CC:DD:EE:FF', pollFrequency: 2 })
  try {
    await waitFor(
      () => latestValue(app, 'electrical.heaters.heater.runningState') !== undefined,
      'status on the migrated path'
    )
    assert.ok(app.putHandlers['electrical.heaters.heater.state'])

    // The rename is written back, so saving the config screen later cannot
    // silently move every path to the default id.
    assert.strictEqual(app.savedOptions.id, 'heater')
    assert.strictEqual(app.savedOptions.heaterInstance, undefined)
  } finally {
    plugin.stop()
  }
})

test('a fault raises a notification and clears it again', async () => {
  const { plugin, app, heater } = await startPlugin({ errorCode: 2, powerStatus: 2 })
  try {
    const alarm = latestValue(app, 'notifications.electrical.heaters.cabinHeater.error')
    assert.strictEqual(alarm.state, 'alarm')
    assert.match(alarm.message, /Lack of fuel/)
    assert.strictEqual(latestValue(app, 'electrical.heaters.cabinHeater.state'), false)
    assert.strictEqual(latestValue(app, 'electrical.heaters.cabinHeater.errorMessage'), 'Lack of fuel')

    heater.state.errorCode = 0
    heater.state.powerStatus = 1
    await put(app, 'electrical.heaters.cabinHeater.mode', protocol.MODE.TEMPERATURE)
    await waitFor(
      () => latestValue(app, 'notifications.electrical.heaters.cabinHeater.error').state === 'normal',
      'notification to clear'
    )
  } finally {
    plugin.stop()
  }
})
