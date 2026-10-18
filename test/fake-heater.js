'use strict'

/*
 * A BLE heater simulator that stands in for node-ble, so the whole plugin can
 * be exercised without hardware: it answers every command with a status frame
 * echoing that command, exactly as the real unit does.
 */

const EventEmitter = require('node:events')
const path = require('node:path')
const protocol = require('../lib/protocol')
const { buildResponse } = require('./frame-builder')

class FakeHeater extends EventEmitter {
  constructor(initial = {}) {
    super()
    this.state = Object.assign(
      {
        powerStatus: 0,
        runningStep: 0,
        mode: protocol.MODE.TEMPERATURE,
        target: 22,
        currentLevelRaw: 4,
        voltage: 13.4,
        chamberTemperature: 20,
        roomTemperature: 19,
        displayError: 0,
        errorCode: 0,
        variant: protocol.VARIANT_DEFAULT
      },
      initial
    )
    this.commands = []
    this.silent = false
    this.refuseWriteWithResponse = false
  }

  // Applies a command frame and returns the status frame to notify with.
  handleCommand(buffer) {
    const cmd = buffer[4]
    const value = buffer[5] | (buffer[6] << 8)
    this.commands.push({ cmd, value })

    if (cmd === protocol.CMD.MODE) {
      this.state.mode = value
    } else if (cmd === protocol.CMD.POWER) {
      if (value === 1) {
        this.state.powerStatus = 1
        this.state.runningStep = 3
      } else {
        this.state.powerStatus = 0
        this.state.runningStep = 0
      }
    } else if (cmd === protocol.CMD.TARGET) {
      this.state.target = value
    }

    return buildResponse(Object.assign({}, this.state, { echo: cmd }))
  }
}

class FakeCharacteristic extends EventEmitter {
  constructor(heater) {
    super()
    this.heater = heater
    this.writes = []
  }

  async startNotifications() {}

  async stopNotifications() {}

  // The real heater rejects reliable writes, so this stands in for a plain ATT
  // write request. Set heater.refuseWriteWithResponse to exercise the fallback.
  async writeValueWithResponse(buffer) {
    if (this.heater.refuseWriteWithResponse) {
      const err = new Error('Write not permitted')
      err.text = 'Write not permitted'
      throw err
    }
    return this.accept('request', buffer)
  }

  async writeValueWithoutResponse(buffer) {
    return this.accept('command', buffer)
  }

  accept(mode, buffer) {
    this.writes.push(mode)
    if (this.heater.silent) {
      return
    }
    const response = this.heater.handleCommand(buffer)
    setImmediate(() => this.emit('valuechanged', response))
  }
}

class FakeDevice extends EventEmitter {
  constructor(heater) {
    super()
    this.heater = heater
    this.characteristic = new FakeCharacteristic(heater)
    this.connectedFlag = false
  }

  async isConnected() {
    return this.connectedFlag
  }

  async connect() {
    this.connectedFlag = true
  }

  async disconnect() {
    this.connectedFlag = false
    this.emit('disconnect', { connected: false })
  }

  async gatt() {
    const characteristic = this.characteristic
    return {
      getPrimaryService: async () => ({
        getCharacteristic: async () => characteristic
      })
    }
  }
}

// Replaces node-ble in the require cache as seen from lib/, so the plugin loads
// the simulator instead of talking to BlueZ.
function installFakeBluetooth(heater) {
  const device = new FakeDevice(heater)
  const adapter = {
    discovering: false,
    isDiscovering: async () => adapter.discovering,
    startDiscovery: async () => {
      adapter.discovering = true
    },
    stopDiscovery: async () => {
      adapter.discovering = false
    },
    waitDevice: async () => device
  }

  const nodeBlePath = require.resolve('node-ble', { paths: [path.join(__dirname, '..', 'lib')] })
  require.cache[nodeBlePath] = {
    id: nodeBlePath,
    filename: nodeBlePath,
    loaded: true,
    exports: {
      createBluetooth: () => ({
        bluetooth: { defaultAdapter: async () => adapter },
        destroy: () => {}
      })
    }
  }

  return { device, adapter }
}

module.exports = { FakeHeater, installFakeBluetooth }
