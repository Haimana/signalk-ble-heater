'use strict'

const test = require('node:test')
const assert = require('node:assert')
const protocol = require('../lib/protocol')
const { FakeHeater, installFakeBluetooth } = require('./fake-heater')
const { FakeBleApi } = require('./fake-bleapi')

const MAC = 'aa:bb:cc:dd:ee:ff'
const MAC_UC = 'AA:BB:CC:DD:EE:FF'
const BASE = 'electrical.heaters.cabinHeater.'

function createApp(bleApi) {
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
    savePluginOptions: (_c, cb) => cb && cb()
  }
  if (bleApi) {
    app.bleApi = bleApi
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

function put(app, path, value) {
  return new Promise((resolve) => {
    const immediate = app.putHandlers[path](null, path, value, resolve)
    if (immediate && immediate.state !== 'PENDING') {
      resolve(immediate)
    }
  })
}

async function waitFor(predicate, label, timeout = 3000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function loadPlugin(app) {
  delete require.cache[require.resolve('../index.js')]
  return require('../index.js')(app)
}

function options(extra = {}) {
  return Object.assign(
    { id: 'cabinHeater', zone: 'saloon', MAC, password: '1234', pollFrequency: 2, _backoffMin: 20 },
    extra
  )
}

async function startServerPlugin(apiOptions = {}, pluginOptions = {}, { seen = true } = {}) {
  const heater = new FakeHeater()
  const bleApi = new FakeBleApi(heater, apiOptions)
  if (seen) {
    bleApi.see(MAC_UC)
  }
  const app = createApp(bleApi)
  const plugin = loadPlugin(app)
  plugin.start(options(pluginOptions))
  return { heater, bleApi, app, plugin }
}

test('auto picks the Signal K BLE API when the server manages Bluetooth', async () => {
  const { app, plugin, bleApi } = await startServerPlugin()
  try {
    await waitFor(() => latestValue(app, BASE + 'runningState') !== undefined, 'first status')
    assert.strictEqual(latestValue(app, BASE + 'ble.backend'), 'server')
    assert.strictEqual(latestValue(app, BASE + 'ble.connectionState'), 'connected')
    assert.strictEqual(latestValue(app, BASE + 'ble.provider'), '_localBLE:hci0')
    assert.strictEqual(bleApi.getGATTClaims().get(MAC_UC), 'signalk-ble-heater')
    // Listed as advertisement subscriber too, for RSSI and BLE Manager.
    assert.ok(bleApi.advertisementCallbacks.has('signalk-ble-heater'))
  } finally {
    await plugin.stop()
  }
})

test('commands go through handle.write and come back confirmed', async () => {
  const { app, plugin, bleApi, heater } = await startServerPlugin()
  try {
    await waitFor(() => latestValue(app, BASE + 'ble.connectionState') === 'connected', 'connected')
    const result = await put(app, BASE + 'state', true)
    assert.strictEqual(result.statusCode, 200)
    assert.ok(heater.commands.some((c) => c.cmd === protocol.CMD.POWER && c.value === 1))
    assert.strictEqual(latestValue(app, BASE + 'state'), true)
    // Local provider: withResponse=true would be a refused reliable write.
    assert.ok(bleApi.writes.length > 0)
    assert.ok(bleApi.writes.every((w) => w.withResponse === false))
    assert.ok(bleApi.writes.every((w) => w.uuid === '0000ffe1-0000-1000-8000-00805f9b34fb'))
  } finally {
    await plugin.stop()
  }
})

test('stop closes the GATT handle and releases the claim', async () => {
  const { app, plugin, bleApi } = await startServerPlugin()
  await waitFor(() => latestValue(app, BASE + 'ble.connectionState') === 'connected', 'connected')
  await plugin.stop()
  assert.strictEqual(bleApi.claims.size, 0)
  assert.ok(bleApi.closeCalls >= 1)
  assert.strictEqual(bleApi.advertisementCallbacks.size, 0)
})

test('a dropped link is closed and subscribed again', async () => {
  const { app, plugin, bleApi } = await startServerPlugin()
  try {
    await waitFor(() => latestValue(app, BASE + 'ble.connectionState') === 'connected', 'connected')
    assert.strictEqual(bleApi.subscribeCalls, 1)
    bleApi.handles[0]._drop()
    await waitFor(() => bleApi.subscribeCalls === 2 && bleApi.handles[1].connected, 'resubscribe')
    assert.ok(bleApi.closeCalls >= 1)
    await waitFor(() => latestValue(app, BASE + 'ble.connectionState') === 'connected', 'connected again')
    const result = await put(app, BASE + 'state', true)
    assert.strictEqual(result.statusCode, 200)
  } finally {
    await plugin.stop()
  }
})

test('waits for the heater to advertise before subscribing', async () => {
  const { app, plugin, bleApi } = await startServerPlugin({}, {}, { seen: false })
  try {
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.strictEqual(bleApi.subscribeCalls, 0)
    bleApi.advertise(MAC_UC, -71)
    await waitFor(() => latestValue(app, BASE + 'runningState') !== undefined, 'first status')
    assert.strictEqual(bleApi.subscribeCalls, 1)
    assert.strictEqual(latestValue(app, BASE + 'ble.rssi'), -71)
  } finally {
    await plugin.stop()
  }
})

test('remote gateway style handle that connects later works', async () => {
  const { app, plugin } = await startServerPlugin({ remote: true, refuseWithResponse: false }, { bleBackend: 'server' })
  try {
    await waitFor(() => latestValue(app, BASE + 'runningState') !== undefined, 'first status')
    assert.strictEqual(latestValue(app, BASE + 'ble.provider'), 'ble:gateway:esp32-saloon')
  } finally {
    await plugin.stop()
  }
})

test('a heater that ignores write-without-response gets write-with-response', async () => {
  const { app, plugin, bleApi } = await startServerPlugin({ ignoreWithoutResponse: true, refuseWithResponse: false })
  try {
    await waitFor(() => latestValue(app, BASE + 'runningState') !== undefined, 'first status', 15000)
    assert.ok(bleApi.writes.some((w) => w.withResponse === true))
  } finally {
    await plugin.stop()
  }
})

test('status frames split over two notifications are reassembled', async () => {
  const heater = new FakeHeater({ roomTemperature: 17 })
  const bleApi = new FakeBleApi(heater)
  bleApi.splitFrames = true
  bleApi.see(MAC_UC)
  const app = createApp(bleApi)
  const plugin = loadPlugin(app)
  plugin.start(options())
  try {
    await waitFor(() => latestValue(app, BASE + 'runningState') !== undefined, 'first status')
    assert.ok(Math.abs(latestValue(app, 'environment.inside.saloon.temperature') - 290.15) < 0.001)
  } finally {
    await plugin.stop()
  }
})

test('auto falls back to direct node-ble when the server neither manages Bluetooth nor sees the heater', async () => {
  const heater = new FakeHeater()
  installFakeBluetooth(heater)
  const bleApi = new FakeBleApi(new FakeHeater(), { localBluetoothManaged: false })
  const app = createApp(bleApi)
  const plugin = loadPlugin(app)
  plugin.start(options())
  try {
    await waitFor(() => latestValue(app, BASE + 'runningState') !== undefined, 'first status')
    assert.strictEqual(latestValue(app, BASE + 'ble.backend'), 'direct')
    assert.strictEqual(bleApi.subscribeCalls, 0)
  } finally {
    await plugin.stop()
  }
})

test('auto uses the BLE API when only a remote gateway sees the heater', async () => {
  const { app, plugin, bleApi } = await startServerPlugin({ localBluetoothManaged: false, remote: true, refuseWithResponse: false })
  try {
    await waitFor(() => latestValue(app, BASE + 'runningState') !== undefined, 'first status')
    assert.strictEqual(latestValue(app, BASE + 'ble.backend'), 'server')
    assert.strictEqual(bleApi.subscribeCalls, 1)
  } finally {
    await plugin.stop()
  }
})

test('bleBackend direct never touches app.bleApi', async () => {
  const heater = new FakeHeater()
  installFakeBluetooth(heater)
  const bleApi = new FakeBleApi(new FakeHeater())
  bleApi.see(MAC_UC)
  const app = createApp(bleApi)
  const plugin = loadPlugin(app)
  plugin.start(options({ bleBackend: 'direct' }))
  try {
    await waitFor(() => latestValue(app, BASE + 'runningState') !== undefined, 'first status')
    assert.strictEqual(latestValue(app, BASE + 'ble.backend'), 'direct')
    assert.strictEqual(bleApi.subscribeCalls, 0)
    assert.strictEqual(bleApi.advertisementCallbacks.size, 0)
  } finally {
    await plugin.stop()
  }
})

test('bleBackend server without app.bleApi reports a clear plugin error', async () => {
  const app = createApp(null)
  const plugin = loadPlugin(app)
  plugin.start(options({ bleBackend: 'server' }))
  try {
    await waitFor(() => app.error !== null, 'plugin error')
    assert.match(app.error, /2\.31/)
  } finally {
    await plugin.stop()
  }
})
