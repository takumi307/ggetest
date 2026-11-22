import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { aquaKey, asObject, loadJson, saveJson } from '@/utils/helpers'

const storageKey = 'ggeEntryPreferences'
const accountKey = (id) => `user:${id}`
const fieldKey = (key, field) => `${key}:${field}`

export const useEntryPreferencesStore = defineStore('entryPreferences', () => {
  const accounts = ref(asObject(loadJson(storageKey, {})))
  watch(accounts, (value) => saveJson(storageKey, value), { deep: true })

  function get(id, entry, field) {
    return accounts.value[accountKey(id)]?.[fieldKey(aquaKey(entry), field)]
  }

  function put(id, record) {
    const key = accountKey(id)
    accounts.value[key] ||= {}
    accounts.value[key][fieldKey(record.key, record.field)] = record
  }

  function set(id, entry, field, value) {
    const previous = get(id, entry, field)
    if ((previous?.value ?? '') === value) return
    put(id, { key: aquaKey(entry), field, value, updatedAt: Math.max(Date.now(), (previous?.updatedAt || 0) + 1), dirty: true })
  }

  function seed(id, entry, field, value) {
    if (!value || get(id, entry, field)) return
    put(id, { key: aquaKey(entry), field, value, updatedAt: Math.max(1, Number(entry.updatedAt) || 1), dirty: true })
  }

  function adoptGuest(id) {
    for (const record of Object.values(accounts.value[accountKey('')] || {})) {
      if (!accounts.value[accountKey(id)]?.[fieldKey(record.key, record.field)]) put(id, { ...record })
    }
    delete accounts.value[accountKey('')]
  }

  function pending(id, types, limit = 100) {
    return Object.values(accounts.value[accountKey(id)] || {}).filter((record) =>
      record.dirty && types.includes(record.key.split('|')[0])).slice(0, limit).map((record) => {
      const [type, x, y] = record.key.split('|')
      return { type, x: Number(x), y: Number(y), field: record.field, value: record.value, updatedAt: record.updatedAt }
    })
  }

  function apply(id, records) {
    for (const record of records) {
      if (!record || typeof record.key !== 'string' || !['label', 'favorite'].includes(record.field) ||
          typeof record.value !== 'string' || !Number.isSafeInteger(record.updatedAt)) continue
      const current = accounts.value[accountKey(id)]?.[fieldKey(record.key, record.field)]
      if (!current || record.updatedAt > current.updatedAt ||
          (record.updatedAt === current.updatedAt && record.value >= current.value)) {
        if (!current || current.dirty || current.updatedAt !== record.updatedAt || current.value !== record.value) {
          put(id, { ...record, dirty: false })
        }
      }
    }
  }

  return { get, set, seed, adoptGuest, pending, apply }
})
