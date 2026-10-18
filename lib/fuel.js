/*
 * Copyright 2026 SeB (sebba@end.ro) - S/V Haimana 264900475
 *
 * Estimated diesel use from pump pulse rate × volume-per-pulse, plus optional
 * separate-tank remaining fuel.
 *
 * Licensed under the Apache License, Version 2.0
 */

'use strict'

const PUMP_TYPES = {
  0: { label: '16 µL/pulse', microliters: 16 },
  1: { label: '22 µL/pulse', microliters: 22 },
  2: { label: '28 µL/pulse', microliters: 28 },
  3: { label: '32 µL/pulse', microliters: 32 }
}

const DEFAULT_PUMP_TYPE = 1

// Heater cmd 16 indexes: 0 = none (no separate tank), 1..10 = 5..50 L.
const TANK_INDEX_NONE = 0
const TANK_LITERS_BY_INDEX = {
  0: null,
  1: 5,
  2: 10,
  3: 15,
  4: 20,
  5: 25,
  6: 30,
  7: 35,
  8: 40,
  9: 45,
  10: 50
}

const LITERS_PER_HOUR_AT_22UL = {
  1: 0.16,
  2: 0.2,
  3: 0.24,
  4: 0.28,
  5: 0.32,
  6: 0.36,
  7: 0.4,
  8: 0.44,
  9: 0.48,
  10: 0.52
}

const FALLBACK_PULSE_HZ = 1.6

function normalizePumpType(value) {
  const n = Number(value)
  if (!Number.isInteger(n) || !PUMP_TYPES[n]) {
    return DEFAULT_PUMP_TYPE
  }
  return n
}

function microlitersPerPulse(pumpType) {
  return PUMP_TYPES[normalizePumpType(pumpType)].microliters
}

function litersPerHourAt22(level) {
  const n = Math.round(Number(level))
  return LITERS_PER_HOUR_AT_22UL[n] || null
}

function pulseHzForLevel(level) {
  const litersPerHour = litersPerHourAt22(level)
  if (litersPerHour === null) {
    return null
  }
  return (litersPerHour * 1e6) / (22 * 3600)
}

function litersPerHour(level, pumpType) {
  const hz = pulseHzForLevel(level)
  if (hz === null) {
    return null
  }
  return (hz * microlitersPerPulse(pumpType) * 3600) / 1e6
}

function litersFromPulses(pulses, pumpType) {
  return (Number(pulses) * microlitersPerPulse(pumpType)) / 1e6
}

function tankIndexFromLiters(liters) {
  const n = Number(liters)
  if (!Number.isFinite(n) || n <= 0) {
    return TANK_INDEX_NONE
  }
  // Snap to nearest 5 L step in 5..50.
  const snapped = Math.min(50, Math.max(5, Math.round(n / 5) * 5))
  return snapped / 5
}

function litersFromTankIndex(index) {
  const n = Number(index)
  if (!Number.isInteger(n) || !(n in TANK_LITERS_BY_INDEX)) {
    return null
  }
  return TANK_LITERS_BY_INDEX[n]
}

function todayKey(now = new Date()) {
  return now.toISOString().slice(0, 10)
}

class FuelTracker {
  constructor(options = {}) {
    this.pumpType = normalizePumpType(options.pumpType)
    // false = draw from the boat main tank (no remaining estimate).
    this.separateTank = options.separateTank === true
    this.tankCapacityLiters = this.separateTank
      ? litersFromTankIndex(tankIndexFromLiters(options.tankCapacityLiters)) || 5
      : null
    this.totalLiters = Number(options.totalLiters) || 0
    this.dailyLiters = Number(options.dailyLiters) || 0
    this.dailyDate = options.dailyDate || todayKey()
    this.totalPulses = Number(options.totalPulses) || 0
    this.consumedSinceRefuel = Number(options.consumedSinceRefuel) || 0
    this.lastTickAt = null
    this.lastRateLh = 0
    this.lastPulseHz = 0
  }

  setPumpType(pumpType) {
    this.pumpType = normalizePumpType(pumpType)
  }

  setSeparateTank(enabled, capacityLiters) {
    this.separateTank = !!enabled
    if (this.separateTank) {
      this.tankCapacityLiters =
        litersFromTankIndex(tankIndexFromLiters(capacityLiters)) || this.tankCapacityLiters || 5
    } else {
      this.tankCapacityLiters = null
    }
  }

  setTankCapacityLiters(liters) {
    if (!this.separateTank) {
      return
    }
    this.tankCapacityLiters = litersFromTankIndex(tankIndexFromLiters(liters)) || 5
  }

  heaterTankIndex() {
    if (!this.separateTank) {
      return TANK_INDEX_NONE
    }
    return tankIndexFromLiters(this.tankCapacityLiters)
  }

  fuelRemainingLiters() {
    if (!this.separateTank || this.tankCapacityLiters === null) {
      return null
    }
    return Math.max(0, this.tankCapacityLiters - this.consumedSinceRefuel)
  }

  snapshot() {
    this._rollDay()
    return {
      pumpType: this.pumpType,
      pumpLabel: PUMP_TYPES[this.pumpType].label,
      microlitersPerPulse: microlitersPerPulse(this.pumpType),
      separateTank: this.separateTank,
      tankCapacityLiters: this.tankCapacityLiters,
      tankIndex: this.heaterTankIndex(),
      pulseRate: this.lastPulseHz,
      fuelRate: this.lastRateLh,
      fuelConsumed: this.totalLiters,
      fuelConsumedToday: this.dailyLiters,
      fuelConsumedSinceRefuel: this.consumedSinceRefuel,
      fuelRemaining: this.fuelRemainingLiters(),
      pumpPulses: this.totalPulses,
      dailyDate: this.dailyDate
    }
  }

  persistable() {
    this._rollDay()
    return {
      pumpType: this.pumpType,
      separateTank: this.separateTank,
      tankCapacityLiters: this.tankCapacityLiters,
      totalLiters: this.totalLiters,
      dailyLiters: this.dailyLiters,
      dailyDate: this.dailyDate,
      totalPulses: this.totalPulses,
      consumedSinceRefuel: this.consumedSinceRefuel
    }
  }

  tick(status, { now = Date.now() } = {}) {
    this._rollDay(new Date(now))

    let hz = 0
    if (status && status.runningStepCode >= 1 && status.runningStepCode <= 3) {
      const level =
        status.currentPowerLevel !== null && status.currentPowerLevel !== undefined
          ? status.currentPowerLevel
          : status.powerLevel
      hz = pulseHzForLevel(level) || FALLBACK_PULSE_HZ
    }

    if (this.lastTickAt !== null && hz > 0) {
      const dt = Math.max(0, (now - this.lastTickAt) / 1000)
      const seconds = Math.min(dt, 120)
      const pulses = hz * seconds
      const liters = litersFromPulses(pulses, this.pumpType)
      this.totalPulses += pulses
      this.totalLiters += liters
      this.dailyLiters += liters
      if (this.separateTank) {
        this.consumedSinceRefuel += liters
      }
    }

    this.lastTickAt = now
    this.lastPulseHz = hz
    this.lastRateLh = hz > 0 ? (hz * microlitersPerPulse(this.pumpType) * 3600) / 1e6 : 0
    return this.snapshot()
  }

  refuel() {
    this.consumedSinceRefuel = 0
  }

  resetTotal() {
    this.totalLiters = 0
    this.totalPulses = 0
    this.dailyLiters = 0
    this.dailyDate = todayKey()
    this.consumedSinceRefuel = 0
  }

  _rollDay(now = new Date()) {
    const key = todayKey(now)
    if (key !== this.dailyDate) {
      this.dailyLiters = 0
      this.dailyDate = key
    }
  }
}

module.exports = {
  PUMP_TYPES,
  DEFAULT_PUMP_TYPE,
  TANK_INDEX_NONE,
  TANK_LITERS_BY_INDEX,
  LITERS_PER_HOUR_AT_22UL,
  FALLBACK_PULSE_HZ,
  normalizePumpType,
  microlitersPerPulse,
  litersPerHourAt22,
  pulseHzForLevel,
  litersPerHour,
  litersFromPulses,
  tankIndexFromLiters,
  litersFromTankIndex,
  FuelTracker
}
