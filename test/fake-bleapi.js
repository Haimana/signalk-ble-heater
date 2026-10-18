'use strict'

/*
 * Minimal stand-in for the Signal K BLE API (app.bleApi, server >= 2.31),
 * modelled on src/api/ble/index.ts and the local / remote providers: one
 * GATT claim per MAC, subscribeGATT only for devices some provider has seen,
 * handle.close() releases the claim. Writes are fed to a FakeHeater and its
 * answer comes back through the subscription callback.
 */

const { SERVICE_UUID, CHARACTERISTIC_UUID } = require('../lib/heater')

class FakeBleApi {
  constructor(heater, options = {}) {
    this.heater = heater
    this.localBluetoothManaged = options.localBluetoothManaged !== false
    // Like the local provider + this heater: withResponse=true is a BlueZ
    // reliable write, which the heater refuses.
    this.refuseWithResponse = options.refuseWithResponse !== false
    // Like the local provider + a heater that ignores write commands.
    this.ignoreWithoutResponse = options.ignoreWithoutResponse === true
    // Remote gateways return the handle before the link is up.
    this.remote = options.remote === true
    this.providerId = this.remote ? 'ble:gateway:esp32-saloon' : '_localBLE:hci0'
    this.devices = new Map()
    this.claims = new Map()
    this.advertisementCallbacks = new Map()
    this.subscribeCalls = 0
    this.closeCalls = 0
    this.writes = []
    this.handles = []
  }

  see(mac, rssi = -62) {
    const key = mac.toUpperCase()
    const device = {
      mac: key,
      rssi,
      lastSeen: Date.now(),
      connectable: true,
      seenBy: [{ providerId: this.providerId, rssi, lastSeen: Date.now() }]
    }
    this.devices.set(key, device)
    return device
  }

  advertise(mac, rssi = -60) {
    this.see(mac, rssi)
    this.advertisementCallbacks.forEach((cb) =>
      cb({ mac: mac.toUpperCase(), rssi, providerId: this.providerId, timestamp: Date.now() })
    )
  }

  onAdvertisement(pluginId, callback) {
    this.advertisementCallbacks.set(pluginId, callback)
    return () => this.advertisementCallbacks.delete(pluginId)
  }

  async getDevices() {
    return Array.from(this.devices.values())
  }

  async getDevice(mac) {
    return this.devices.get(mac.toUpperCase()) || null
  }

  getGATTClaims() {
    return new Map(this.claims)
  }

  async releaseGATTDevice(mac, pluginId) {
    this.releaseCalls = (this.releaseCalls || 0) + 1
    const key = mac.toUpperCase()
    if (this.claims.get(key) !== pluginId) {
      throw new Error(`Device ${key} is claimed by ${this.claims.get(key)}, not ${pluginId}`)
    }
    this.claims.delete(key)
  }

  async subscribeGATT(descriptor, pluginId, callback) {
    this.subscribeCalls++
    const mac = descriptor.mac.toUpperCase()
    if (this.claims.has(mac)) {
      throw new Error(`Device ${mac} already claimed by ${this.claims.get(mac)}`)
    }
    if (!this.devices.has(mac)) {
      throw new Error(`No provider with GATT support and available slots can see ${mac}`)
    }
    if (descriptor.service !== SERVICE_UUID || !(descriptor.notify || []).includes(CHARACTERISTIC_UUID)) {
      throw new Error('unexpected descriptor')
    }
    this.claims.set(mac, pluginId)

    const api = this
    const state = { connected: !this.remote, closed: false, connectCbs: [], disconnectCbs: [] }
    const handle = {
      descriptor,
      async read() {
        throw new Error('not used')
      },
      async write(uuid, data, withResponse) {
        if (!state.connected) {
          throw new Error('GATT not connected')
        }
        api.writes.push({ uuid, withResponse: withResponse === true, data: Buffer.from(data) })
        if (withResponse === true && api.refuseWithResponse) {
          const err = new Error('Write not permitted')
          err.text = 'Write not permitted'
          throw err
        }
        if (withResponse !== true && api.ignoreWithoutResponse) {
          return
        }
        if (api.heater.silent) {
          return
        }
        const response = api.heater.handleCommand(Buffer.from(data))
        setImmediate(() => {
          if (!state.closed) {
            if (api.splitFrames) {
              callback(CHARACTERISTIC_UUID, response.subarray(0, 10))
              callback(CHARACTERISTIC_UUID, response.subarray(10))
            } else {
              callback(CHARACTERISTIC_UUID, response)
            }
          }
        })
      },
      async close() {
        state.closed = true
        state.connected = false
        api.closeCalls++
        if (api.claims.get(mac) === pluginId) {
          api.claims.delete(mac)
        }
      },
      get connected() {
        return state.connected
      },
      onDisconnect(cb) {
        state.disconnectCbs.push(cb)
      },
      onConnect(cb) {
        state.connectCbs.push(cb)
      },
      // Test helpers
      _connect() {
        state.connected = true
        state.connectCbs.forEach((cb) => cb())
      },
      _drop() {
        state.connected = false
        state.disconnectCbs.forEach((cb) => cb())
      }
    }
    this.handles.push(handle)
    if (this.remote) {
      setTimeout(() => handle._connect(), 20)
    }
    return handle
  }
}

// Stand-in for BlueZ: an orphaned link keeps the heater from advertising
// until it is disconnected.
class FakeBluez {
  constructor(bleApi, mac, { connected = true, failDisconnect = false } = {}) {
    this.bleApi = bleApi
    this.mac = mac
    this.connected = connected
    this.failDisconnect = failDisconnect
    this.checks = 0
    this.disconnects = []
  }

  async isConnected(adapter, mac) {
    this.checks++
    return mac === this.mac && this.connected
  }

  async disconnect(adapter, mac) {
    if (this.failDisconnect) {
      throw new Error('org.bluez.Error.Failed')
    }
    this.disconnects.push({ adapter, mac })
    this.connected = false
    // Free again: the heater starts advertising.
    setTimeout(() => this.bleApi.advertise(mac, -58), 10)
    return 'dbus'
  }
}

module.exports = { FakeBleApi, FakeBluez }
