/*
 * Copyright 2026 SeB (sebba@end.ro) - S/V Haimana 264900475
 *
 * Persistent BLE session with the heater: one connection, one in-flight write,
 * automatic reconnect. Commands resolve from the notification that echoes them,
 * so callers always see what the heater actually did.
 *
 * Two transports share the queue, polling and frame handling:
 *   - HeaterSession: direct node-ble / BlueZ D-Bus connection (legacy mode).
 *   - ServerHeaterSession: Signal K BLE API (app.bleApi, server >= 2.31). The
 *     server owns the adapter (or a remote gateway), the GATT claim shows up
 *     in Data -> BLE Manager, and the plugin never touches BlueZ itself.
 *
 * The direct connection lifecycle (dbus-next rejection patch, BlueZ stale
 * connection cleanup, discovery handling, generation counter) is ported from
 * https://github.com/htool/jbd-overkill-bms-plugin
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

const EventEmitter = require('node:events')
const protocol = require('./protocol')

const SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb'
const CHARACTERISTIC_UUID = '0000ffe1-0000-1000-8000-00805f9b34fb'

const WAIT_DEVICE_TIMEOUT = 60000
const CONNECT_TIMEOUT = 20000
// The server's local provider waits up to 30 s for the device and then
// resolves services; a remote gateway answers asynchronously.
const SUBSCRIBE_TIMEOUT = 45000
// Fragments of one status frame must arrive close together.
const FRAGMENT_TIMEOUT = 1000
const FRAME_MIN_LENGTH = 18
const FRAME_MAGIC = 0xaa
const GATT_TIMEOUT = 20000
const COMMAND_TIMEOUT = 5000
const BACKOFF_MIN = 2000
const BACKOFF_MAX = 30000
// Three silent pings in a row means BlueZ is holding a dead link open.
const MAX_SILENT_COMMANDS = 3

class NotConnectedError extends Error {
  constructor() {
    super('Heater is not connected over BLE')
    this.code = 'ENOTCONNECTED'
  }
}

class CommandTimeoutError extends Error {
  constructor(cmd) {
    super(`Heater did not answer command ${cmd}`)
    this.code = 'ETIMEDOUT'
  }
}

function bleErrMessage(err) {
  if (!err) {
    return 'unknown BLE error'
  }
  return err.text || err.message || String(err)
}

function isDisconnectedError(err) {
  return /not connected|disconnected|no such object|not available/i.test(bleErrMessage(err))
}

// dbus-next rejects the ProxyObject method promise from its message handler.
// Some of those calls are internal and nobody awaits them, which surfaces in
// the Signal K log as "Unhandled rejection: DBusError: Not connected".
// Attaching a catch marks them handled; awaited callers still see rejections.
function patchDbusNextUnhandled(debug) {
  let ProxyObject
  try {
    ProxyObject = require('dbus-next/lib/client/proxy-object.js')
  } catch (_e) {
    return
  }
  if (!ProxyObject || !ProxyObject.prototype || ProxyObject.prototype._heaterPatched) {
    return
  }
  ProxyObject.prototype._heaterPatched = true
  const orig = ProxyObject.prototype._callMethod
  ProxyObject.prototype._callMethod = function (iface, member, inSig, outSig, ...args) {
    const p = orig.call(this, iface, member, inSig, outSig, ...args)
    p.catch((err) => debug('dbus %s %s.%s: %s', this.path, iface, member, bleErrMessage(err)))
    return p
  }
}

class HeaterSession extends EventEmitter {
  constructor(options) {
    super()
    this.mac = options.mac
    this.passkey = options.passkey
    this.pollInterval = options.pollInterval
    this.debug = options.debug || (() => {})
    this.backoffMin = options.backoffMin || BACKOFF_MIN
    this.backend = 'direct'

    this.variant = protocol.VARIANT_DEFAULT
    this.lastStatus = null
    this.connectionState = 'stopped'

    this.stopped = true
    this.sessionGen = 0
    this.deviceRef = null
    this.destroyBus = null
    this.characteristic = null
    this.reconnectTimer = null
    this.sleepResolve = null
    this.pollTimer = null
    this.lossResolve = null

    this.queue = []
    this.draining = false
    this.pending = null
    this.silentCommands = 0
    this.writeMode = 'request'
    this.fragment = null
    this.fragmentAt = 0
  }

  // Snapshot for diagnostics: which transport, link state, and (server mode)
  // the provider and RSSI the heater was last seen with.
  linkInfo() {
    return {
      backend: this.backend,
      connectionState: this.connectionState,
      provider: null,
      rssi: null,
      writeMode: this.writeMode
    }
  }

  emitLink() {
    this.emit('link', this.linkInfo())
  }

  // Hook for transports that want to react to a command nobody answered.
  onCommandTimeout() {}

  // node-ble defaults writeValue to a reliable write, which the heater answers
  // with "Write not permitted". A plain ATT write request is what the phone app
  // and every reference implementation use; clones that only advertise
  // write-without-response fall back automatically.
  async writeFrame(characteristic, frame) {
    if (this.writeMode === 'command') {
      return characteristic.writeValueWithoutResponse(frame)
    }
    try {
      return await characteristic.writeValueWithResponse(frame)
    } catch (err) {
      if (!/not permitted|not supported/i.test(bleErrMessage(err))) {
        throw err
      }
      this.debug('Write with response refused, switching to write without response')
      this.writeMode = 'command'
      return characteristic.writeValueWithoutResponse(frame)
    }
  }

  get connected() {
    return this.connectionState === 'connected'
  }

  start() {
    if (!this.mac) {
      throw new Error('Heater BLE MAC address is not set')
    }
    this.stopped = false
    const gen = ++this.sessionGen
    this.runLoop(gen).catch((err) => {
      if (!this.stopped && this.sessionGen === gen) {
        this.emit('failure', `BLE loop died: ${bleErrMessage(err)}`)
      }
    })
  }

  // Synchronous on purpose: Signal K calls plugin.stop() without awaiting, and a
  // pending backoff sleep must not delay it.
  stop() {
    this.stopped = true
    this.sessionGen++
    this.stopPolling()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.sleepResolve) {
      const resolve = this.sleepResolve
      this.sleepResolve = null
      resolve()
    }
    this.failQueue(new NotConnectedError())
    this.setState('stopped')
    // Returned so an async plugin.stop() can wait for the link (and, in server
    // mode, the GATT claim) to be released. Callers that do not await are fine.
    return Promise.resolve(this.teardownSession()).catch(() => {})
  }

  send(cmd, value = 0) {
    if (this.stopped) {
      return Promise.reject(new NotConnectedError())
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ cmd, value, resolve, reject })
      this.processQueue().catch((err) => this.debug('queue: %s', bleErrMessage(err)))
    })
  }

  setState(state, detail) {
    if (this.connectionState === state && !detail) {
      return
    }
    this.connectionState = state
    this.emit('connection', state, detail)
    this.emitLink()
  }

  sleep(ms) {
    return new Promise((resolve) => {
      this.sleepResolve = resolve
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        this.sleepResolve = null
        resolve()
      }, ms)
    })
  }

  async withTimeout(promise, ms, label) {
    let timer
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      clearTimeout(timer)
      // A timed-out BlueZ call still settles later; swallow it so it does not
      // become an unhandled rejection.
      Promise.resolve(promise).catch(() => {})
    }
  }

  async runLoop(gen) {
    let backoff = this.backoffMin
    while (!this.stopped && this.sessionGen === gen) {
      try {
        this.setState('connecting')
        const session = await this.openSession()
        if (this.stopped || this.sessionGen !== gen) {
          return
        }
        backoff = this.backoffMin
        this.silentCommands = 0
        this.characteristic = session.characteristic
        this.setState('connected')
        this.startPolling()
        this.processQueue().catch(() => {})
        await this.waitUntilLost(session)
      } catch (err) {
        if (!this.stopped && this.sessionGen === gen) {
          this.emit('failure', bleErrMessage(err))
        }
      } finally {
        this.stopPolling()
        this.characteristic = null
        if (this.sessionGen === gen) {
          await this.teardownSession()
        }
      }
      if (!this.stopped && this.sessionGen === gen) {
        this.setState('reconnecting')
        await this.sleep(backoff)
        backoff = Math.min(backoff * 2, BACKOFF_MAX)
      }
    }
  }

  async openSession() {
    const { createBluetooth } = require('node-ble')
    patchDbusNextUnhandled(this.debug)
    const { bluetooth, destroy } = createBluetooth()
    this.destroyBus = destroy

    const adapter = await bluetooth.defaultAdapter()
    let weStartedDiscovery = false
    if (!(await adapter.isDiscovering())) {
      this.debug('Starting BLE discovery for %s', this.mac)
      await adapter.startDiscovery()
      weStartedDiscovery = true
    }

    try {
      this.debug('Waiting for heater %s', this.mac)
      const device = await this.withTimeout(
        adapter.waitDevice(this.mac),
        WAIT_DEVICE_TIMEOUT,
        `Waiting for heater ${this.mac}`
      )
      this.deviceRef = device

      if (await device.isConnected()) {
        this.debug('Dropping leftover BlueZ connection before reconnect')
        try {
          await device.disconnect()
        } catch (_e) {}
        await this.sleep(500)
      }

      this.debug('Connecting to %s', this.mac)
      await this.withTimeout(device.connect(), CONNECT_TIMEOUT, `Connect ${this.mac}`)
      if (weStartedDiscovery) {
        await this.safeStopDiscovery(adapter)
        weStartedDiscovery = false
      }

      const gattServer = await this.withTimeout(device.gatt(), GATT_TIMEOUT, `GATT ${this.mac}`)
      const service = await gattServer.getPrimaryService(SERVICE_UUID)
      const characteristic = await service.getCharacteristic(CHARACTERISTIC_UUID)
      await characteristic.startNotifications()
      characteristic.on('valuechanged', (buffer) => this.onNotification(buffer))
      this.debug('Notifications started')

      return { device, characteristic }
    } finally {
      if (weStartedDiscovery) {
        await this.safeStopDiscovery(adapter)
      }
    }
  }

  async safeStopDiscovery(adapter) {
    try {
      if (adapter && (await adapter.isDiscovering())) {
        await adapter.stopDiscovery()
      }
    } catch (_e) {}
  }

  async teardownSession() {
    const device = this.deviceRef
    const destroy = this.destroyBus
    this.deviceRef = null
    this.destroyBus = null
    if (device) {
      try {
        await device.disconnect()
      } catch (_e) {}
    }
    if (typeof destroy === 'function') {
      try {
        destroy()
      } catch (_e) {}
    }
  }

  waitUntilLost(session) {
    return new Promise((resolve) => {
      let settled = false
      const lost = () => {
        if (settled) {
          return
        }
        settled = true
        this.lossResolve = null
        resolve()
      }
      this.lossResolve = lost
      try {
        session.device.on('disconnect', lost)
      } catch (_e) {}
    })
  }

  signalLoss() {
    if (this.lossResolve) {
      this.lossResolve()
    }
  }

  startPolling() {
    this.stopPolling()
    const tick = () => this.send(protocol.CMD.PING).catch(() => {})
    tick()
    this.pollTimer = setInterval(tick, this.pollInterval)
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  failQueue(err) {
    const jobs = this.queue
    this.queue = []
    jobs.forEach((job) => job.reject(err))
    if (this.pending) {
      this.pending.reject(err)
    }
  }

  // One write at a time. The ping goes through the same queue, so a poll can
  // never overlap a command.
  async processQueue() {
    if (this.draining) {
      return
    }
    this.draining = true
    try {
      while (this.queue.length) {
        const job = this.queue.shift()
        if (!this.characteristic) {
          job.reject(new NotConnectedError())
          continue
        }
        try {
          job.resolve(await this.writeAndAwait(job.cmd, job.value))
          this.silentCommands = 0
        } catch (err) {
          job.reject(err)
          if (isDisconnectedError(err)) {
            this.debug('Write failed, link is gone: %s', bleErrMessage(err))
            this.signalLoss()
          } else if (err.code === 'ETIMEDOUT') {
            this.silentCommands++
            this.onCommandTimeout()
            if (this.silentCommands >= MAX_SILENT_COMMANDS) {
              this.debug('No answer to %d commands in a row, dropping the link', this.silentCommands)
              this.signalLoss()
            }
          }
        }
      }
    } finally {
      this.draining = false
    }
  }

  writeAndAwait(cmd, value) {
    const frame = protocol.buildCommand(cmd, value, this.passkey, this.variant)
    const characteristic = this.characteristic
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null
        reject(new CommandTimeoutError(cmd))
      }, COMMAND_TIMEOUT)

      const settle = (fn) => (arg) => {
        clearTimeout(timer)
        this.pending = null
        fn(arg)
      }
      this.pending = { cmd, resolve: settle(resolve), reject: settle(reject) }

      this.writeFrame(characteristic, frame).catch((err) => {
        if (this.pending) {
          this.pending.reject(err)
        }
      })
    })
  }

  // A status frame normally arrives in one notification (18 or 20 bytes fit
  // the default ATT MTU). Should a transport split it, glue fragments that
  // start with the 0xAA magic and follow each other quickly.
  reassemble(buffer) {
    const now = Date.now()
    if (this.fragment && now - this.fragmentAt > FRAGMENT_TIMEOUT) {
      this.fragment = null
    }
    if (buffer.length && buffer[0] === FRAME_MAGIC) {
      if (buffer.length >= FRAME_MIN_LENGTH) {
        this.fragment = null
        return buffer
      }
      this.fragment = buffer
      this.fragmentAt = now
      return null
    }
    if (this.fragment) {
      const joined = Buffer.concat([this.fragment, buffer])
      if (joined.length >= FRAME_MIN_LENGTH) {
        this.fragment = null
        return joined
      }
      this.fragment = joined
      this.fragmentAt = now
      return null
    }
    return buffer
  }

  onNotification(raw) {
    const buffer = this.reassemble(Buffer.isBuffer(raw) ? raw : Buffer.from(raw))
    if (!buffer) {
      return
    }
    const status = protocol.parseFrame(buffer)
    if (!status.ok) {
      this.debug('Ignoring frame: %s (%s)', status.reason, buffer.toString('hex'))
      return
    }
    if (!status.checksumOk) {
      this.debug('Checksum mismatch, frame kept: %s', buffer.toString('hex'))
    }
    if (status.variant !== this.variant) {
      this.variant = status.variant
      if (status.variant !== protocol.VARIANT_DEFAULT) {
        this.emit(
          'failure',
          `Heater speaks protocol variant 0x${status.variant.toString(16)}, error codes may differ`
        )
      }
    }

    this.lastStatus = status
    if (status.errorCode || status.powerStatusCode === 2) {
      this.debug(
        'Fault frame %s err=%d display=%d step=%d power=%d msg=%s',
        buffer.toString('hex'),
        status.errorCode,
        status.displayErrorCode,
        status.runningStepCode,
        status.powerStatusCode,
        status.errorMessage || '-'
      )
    }
    if (this.pending && this.pending.cmd === status.echo) {
      this.pending.resolve(status)
    }
    this.emit('status', status)
  }
}

function normalizeMac(mac) {
  return String(mac || '').trim().toUpperCase()
}

function sameUuid(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase()
}

/*
 * Same session semantics as HeaterSession, but the link goes through the
 * Signal K BLE API: app.bleApi.subscribeGATT() picks the provider (local
 * adapter managed by the server, or a remote ESP32 gateway), holds the GATT
 * claim for this plugin and delivers FFE1 notifications. Commands are written
 * with handle.write(). On any disconnect the handle is closed and a fresh
 * subscription is made, which works the same for local and remote providers.
 */
class ServerHeaterSession extends HeaterSession {
  constructor(options) {
    super(options)
    this.bleApi = options.bleApi
    this.pluginId = options.pluginId
    this.backend = 'server'
    this.mac = normalizeMac(options.mac)

    // The server's local provider maps withResponse=true to a BlueZ
    // "reliable" write, which this heater refuses, and withResponse=false to
    // a write command. Remote SensESP gateways always use a write request.
    // auto: start with write-without-response, switch once if the heater
    // refuses it or never answers.
    const mode = options.writeMode || 'auto'
    this.writeMode = mode === 'with-response' ? 'request' : 'command'
    this.writeModeLocked = mode === 'with-response' || mode === 'without-response'
    this.writeModeSwitched = false

    this.handle = null
    this.handleLost = false
    this.advUnsubscribe = null
    this.advWaiters = new Set()
    this.provider = null
    this.rssi = null
    this.lastSeen = null
    this.framesThisLink = 0
  }

  linkInfo() {
    return Object.assign(super.linkInfo(), {
      provider: this.provider,
      rssi: this.rssi,
      lastSeen: this.lastSeen
    })
  }

  start() {
    if (!this.mac) {
      throw new Error('Heater BLE MAC address is not set')
    }
    if (!this.bleApi || typeof this.bleApi.subscribeGATT !== 'function') {
      throw new Error('Signal K BLE API (app.bleApi) is not available')
    }
    if (typeof this.bleApi.onAdvertisement === 'function' && !this.advUnsubscribe) {
      // Kept for the whole session: gives RSSI / provider for diagnostics and
      // wakes the connect loop as soon as the heater advertises.
      this.advUnsubscribe = this.bleApi.onAdvertisement(this.pluginId, (adv) => this.onAdvertisement(adv))
    }
    super.start()
  }

  stop() {
    if (this.advUnsubscribe) {
      try {
        this.advUnsubscribe()
      } catch (_e) {}
      this.advUnsubscribe = null
    }
    this.advWaiters.forEach((waiter) => waiter(false))
    this.advWaiters.clear()
    return super.stop()
  }

  onAdvertisement(adv) {
    if (!adv || normalizeMac(adv.mac) !== this.mac) {
      return
    }
    if (typeof adv.rssi === 'number') {
      this.rssi = adv.rssi
    }
    if (adv.providerId) {
      this.provider = adv.providerId
    }
    this.lastSeen = adv.timestamp || Date.now()
    this.advWaiters.forEach((waiter) => waiter(true))
    this.advWaiters.clear()
    this.emitLink()
  }

  async refreshFromDeviceTable() {
    if (typeof this.bleApi.getDevice !== 'function') {
      return null
    }
    let device = null
    try {
      device = await this.bleApi.getDevice(this.mac)
    } catch (_e) {
      return null
    }
    if (device) {
      const best = (device.seenBy || []).slice().sort((a, b) => b.rssi - a.rssi)[0]
      if (best) {
        this.provider = best.providerId
        this.rssi = best.rssi
      } else if (typeof device.rssi === 'number') {
        this.rssi = device.rssi
      }
      this.lastSeen = device.lastSeen || this.lastSeen
    }
    return device
  }

  // subscribeGATT only works for a device some provider has seen, so wait for
  // the heater to show up in the server's device table or advertise.
  async waitForDevice() {
    if (await this.refreshFromDeviceTable()) {
      return
    }
    this.debug('Waiting for heater %s to be seen by a Signal K BLE provider', this.mac)
    const seen = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.advWaiters.delete(waiter)
        resolve(false)
      }, WAIT_DEVICE_TIMEOUT)
      const waiter = (ok) => {
        clearTimeout(timer)
        resolve(ok)
      }
      this.advWaiters.add(waiter)
    })
    if (!seen && !this.stopped) {
      throw new Error(
        `Heater ${this.mac} not seen by any Signal K BLE provider. Enable Server Settings -> Bluetooth or bring a BLE gateway in range`
      )
    }
  }

  waitConnected(handle) {
    if (handle.connected) {
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Connect ${this.mac} timed out`)), CONNECT_TIMEOUT)
      this.connectWaiter = (ok) => {
        clearTimeout(timer)
        this.connectWaiter = null
        if (ok) {
          resolve()
        } else {
          reject(new Error(`GATT link to ${this.mac} dropped while connecting`))
        }
      }
    })
  }

  async openSession() {
    await this.waitForDevice()
    if (this.stopped) {
      throw new Error('stopped')
    }

    const descriptor = {
      mac: this.mac,
      service: SERVICE_UUID,
      notify: [CHARACTERISTIC_UUID]
    }
    this.handleLost = false
    this.framesThisLink = 0
    this.debug('subscribeGATT %s via Signal K BLE API', this.mac)
    const pending = Promise.resolve(
      this.bleApi.subscribeGATT(descriptor, this.pluginId, (uuid, data) => {
        if (!uuid || sameUuid(uuid, CHARACTERISTIC_UUID)) {
          this.framesThisLink++
          this.onNotification(data)
        }
      })
    )
    let handle
    try {
      handle = await this.withTimeout(pending, SUBSCRIBE_TIMEOUT, `subscribeGATT ${this.mac}`)
    } catch (err) {
      // A subscription that completes after we gave up must not keep the claim.
      pending.then((late) => late && late.close()).catch(() => {})
      throw err
    }
    this.handle = handle
    if (this.stopped) {
      await this.teardownSession()
      throw new Error('stopped')
    }

    handle.onDisconnect(() => {
      if (this.handle !== handle) {
        return
      }
      this.debug('GATT link to %s reported down by the server', this.mac)
      this.handleLost = true
      if (this.connectWaiter) {
        this.connectWaiter(false)
      }
      this.signalLoss()
    })
    handle.onConnect(() => {
      if (this.handle === handle && this.connectWaiter) {
        this.connectWaiter(true)
      }
      this.emitLink()
    })

    await this.waitConnected(handle)
    if (this.handleLost) {
      throw new Error(`GATT link to ${this.mac} lost during setup`)
    }
    await this.refreshFromDeviceTable()
    this.debug('Heater %s connected via %s', this.mac, this.provider || 'Signal K BLE API')
    return { device: null, characteristic: handle }
  }

  waitUntilLost() {
    return new Promise((resolve) => {
      if (this.handleLost) {
        resolve()
        return
      }
      this.lossResolve = () => {
        this.lossResolve = null
        resolve()
      }
    })
  }

  async teardownSession() {
    const handle = this.handle
    this.handle = null
    if (this.connectWaiter) {
      this.connectWaiter(false)
    }
    if (handle) {
      try {
        // Releases the GATT claim in the server (BLE Manager shows it freed).
        await handle.close()
      } catch (err) {
        this.debug('GATT close: %s', bleErrMessage(err))
      }
    }
  }

  switchWriteMode(reason) {
    this.writeMode = this.writeMode === 'command' ? 'request' : 'command'
    this.writeModeSwitched = true
    this.debug('%s, switching to %s', reason, this.writeMode === 'command' ? 'write without response' : 'write with response')
    this.emitLink()
  }

  async writeFrame(handle, frame) {
    try {
      return await handle.write(CHARACTERISTIC_UUID, frame, this.writeMode === 'request')
    } catch (err) {
      if (this.writeModeLocked || this.writeModeSwitched || !/not permitted|not supported/i.test(bleErrMessage(err))) {
        throw err
      }
      this.switchWriteMode(`Write refused (${bleErrMessage(err)})`)
      return handle.write(CHARACTERISTIC_UUID, frame, this.writeMode === 'request')
    }
  }

  // Writes that "succeed" but never get an echo usually mean the heater ignores
  // this write type. Try the other one once before declaring the link dead.
  onCommandTimeout() {
    if (!this.writeModeLocked && !this.writeModeSwitched && this.framesThisLink === 0 && this.silentCommands >= 2) {
      this.switchWriteMode('No answer to any command on this link')
      this.silentCommands = 0
    }
  }
}

function createSession(backend, options) {
  return backend === 'server' ? new ServerHeaterSession(options) : new HeaterSession(options)
}

module.exports = {
  HeaterSession,
  ServerHeaterSession,
  createSession,
  NotConnectedError,
  CommandTimeoutError,
  bleErrMessage,
  isDisconnectedError,
  SERVICE_UUID,
  CHARACTERISTIC_UUID,
  COMMAND_TIMEOUT
}
