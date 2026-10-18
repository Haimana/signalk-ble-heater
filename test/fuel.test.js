'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fuel = require('../lib/fuel')
const protocol = require('../lib/protocol')

test('pump types map to the LCD microlitre labels', () => {
  assert.strictEqual(fuel.microlitersPerPulse(0), 16)
  assert.strictEqual(fuel.microlitersPerPulse(1), 22)
  assert.strictEqual(fuel.microlitersPerPulse(2), 28)
  assert.strictEqual(fuel.microlitersPerPulse(3), 32)
  assert.strictEqual(fuel.normalizePumpType(99), fuel.DEFAULT_PUMP_TYPE)
})

test('pulse rate follows the Vevor gear table at 22 µL', () => {
  const hz1 = fuel.pulseHzForLevel(1)
  const hz10 = fuel.pulseHzForLevel(10)
  assert.ok(hz1 > 1.9 && hz1 < 2.1)
  assert.ok(hz10 > 6.4 && hz10 < 6.7)
  assert.ok(Math.abs(fuel.litersPerHour(1, 1) - 0.16) < 1e-9)
  assert.ok(Math.abs(fuel.litersPerHour(10, 1) - 0.52) < 1e-9)
})

test('larger pumps burn more fuel at the same pulse rate', () => {
  const at22 = fuel.litersPerHour(5, 1)
  const at32 = fuel.litersPerHour(5, 3)
  assert.ok(Math.abs(at22 - 0.32) < 1e-9)
  assert.ok(at32 > at22)
  assert.ok(Math.abs(at32 - 0.32 * (32 / 22)) < 1e-9)
})

test('boat main tank mode has no remaining estimate', () => {
  const tracker = new fuel.FuelTracker({ separateTank: false, pumpType: 1 })
  assert.strictEqual(tracker.heaterTankIndex(), 0)
  assert.strictEqual(tracker.snapshot().fuelRemaining, null)
})

test('separate tank tracks remaining and snaps capacity to 5 L steps', () => {
  const tracker = new fuel.FuelTracker({
    separateTank: true,
    tankCapacityLiters: 12,
    pumpType: 1
  })
  assert.strictEqual(tracker.tankCapacityLiters, 10)
  assert.strictEqual(tracker.heaterTankIndex(), 2)
  assert.strictEqual(tracker.snapshot().fuelRemaining, 10)

  const running = { runningStepCode: 3, currentPowerLevel: 5, powerLevel: 5 }
  let now = 0
  tracker.tick(running, { now })
  now += 3600 * 1000
  // Cap is 120s per tick, so step in minutes.
  for (let i = 0; i < 60; i++) {
    now += 60 * 1000
    tracker.tick(running, { now })
  }
  const snap = tracker.snapshot()
  assert.ok(Math.abs(snap.fuelConsumed - 0.32) < 0.01)
  assert.ok(snap.fuelRemaining < 10)
  tracker.refuel()
  assert.strictEqual(tracker.snapshot().fuelRemaining, 10)
})

test('settings commands build valid AA55 frames', () => {
  assert.strictEqual(protocol.buildCommand(protocol.CMD.SET_TANK_VOLUME, 0, 1234)[4], 16)
  assert.strictEqual(protocol.buildCommand(protocol.CMD.SET_OFFSET, -3, 1234)[5], 253)
  assert.strictEqual(protocol.buildCommand(protocol.CMD.SET_AUTO_START_STOP, 1, 1234)[4], 18)
  assert.strictEqual(protocol.buildCommand(protocol.CMD.SET_LANGUAGE, 0, 1234)[5], 0)
  assert.ok(protocol.encodeClockArgument(new Date(2026, 0, 1, 14, 30)) === 14 * 60 + 30)
})
