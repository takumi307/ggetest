import { FORT_SHARED_COOLDOWN_MS, FORT_COOLDOWN_OFFSET_MS, FORT_CYCLE_TOLERANCE_MS } from './constants.js'

// 同じ獲得記録の訂正で、終了済みの24時間側を再開しない。
export function correctedMemberCap(previousAt, updatedAt, previousCap) {
  const memberAt = previousAt - FORT_COOLDOWN_OFFSET_MS
  return previousCap ?? (memberAt <= updatedAt ? memberAt : null)
}

export function resolveFortTiming(row) {
  const { personalAt, otherConfirmedAt, observedAt, legacyAt } = row
  const confirmedAt = Math.max(personalAt ?? 0, otherConfirmedAt ?? 0) || null
  const ownBaseline = confirmedAt != null && confirmedAt === personalAt
  const otherBaseline = confirmedAt != null && confirmedAt === otherConfirmedAt
  const firstAt = Math.min(confirmedAt ?? Infinity, ownBaseline ? row.personalFirstAt ?? Infinity : Infinity,
    otherBaseline ? row.otherFirstAt ?? Infinity : Infinity)
  const memberCap = Math.min(ownBaseline ? row.personalMemberCap ?? Infinity : Infinity,
    otherBaseline ? row.otherMemberCap ?? Infinity : Infinity)
  const threshold = Math.max(confirmedAt ?? 0, memberCap === Infinity ? 0 : memberCap + FORT_COOLDOWN_OFFSET_MS)
  const useObservation = observedAt != null && (confirmedAt == null || observedAt > threshold + FORT_CYCLE_TOLERANCE_MS)
  const sharedAt = useObservation ? observedAt : confirmedAt ?? legacyAt
  const sharedMemberAt = sharedAt == null ? null : Math.min(sharedAt - FORT_COOLDOWN_OFFSET_MS, useObservation ? Infinity : memberCap)
  const sharedStartedAt = sharedAt == null ? null : (useObservation || confirmedAt == null ? sharedAt : firstAt) - FORT_SHARED_COOLDOWN_MS
  return { confirmedAt, sharedAt, sharedMemberAt, sharedStartedAt, useObservation }
}

export function fortAttackableAt(fallbackAt, timing) {
  const { sharedMemberAt, sharedStartedAt, readyAt, personalAt } = timing
  const checkedReady = readyAt != null && (sharedStartedAt == null || sharedStartedAt <= readyAt)
  const memberAt = checkedReady ? readyAt : sharedMemberAt ?? fallbackAt
  return Math.max(memberAt, personalAt ?? 0)
}
