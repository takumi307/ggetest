<script setup>
import { computed, onMounted, onBeforeUnmount } from 'vue'
import { useTrackerStore } from '@/stores/trackerStore'
import { useSyncStore } from '@/stores/syncStore'
import { useUiStore } from '@/stores/uiStore'
import AppModal from '@/components/AppModal.vue'
import MainTab from '@/components/MainTab.vue'
import ReadyTab from '@/components/ReadyTab.vue'
import StatsTab from '@/components/StatsTab.vue'
import SettingsTab from '@/components/SettingsTab.vue'

const tracker = useTrackerStore()
const sync = useSyncStore()
const ui = useUiStore()

const tabs = [
  { id: 'main', label: '一覧' },
  { id: 'ready', label: '攻撃可能' },
  { id: 'stats', label: '集計' },
  { id: 'settings', label: '設定' }
]

const chip = computed(() => sync.summary())
function onChip() {
  if (chip.value.state === 'unset') ui.goTab('settings')
  else sync.syncAll()
}

let tickTimer = null
let syncTimer = null
function onVisible() {
  if (document.visibilityState === 'visible') sync.autoSyncIfNeeded()
}

onMounted(() => {
  tickTimer = setInterval(tracker.tick, 1000) // 残り時間の表示更新
  syncTimer = setInterval(sync.autoSyncIfNeeded, 30000) // 同期の時間になったか30秒ごとに確認
  document.addEventListener('visibilitychange', onVisible)
  sync.autoSyncIfNeeded()
  sync.loadAllNotify() // 通知設定（サーバー保存）を読み込む
})
onBeforeUnmount(() => {
  clearInterval(tickTimer)
  clearInterval(syncTimer)
  document.removeEventListener('visibilitychange', onVisible)
})
</script>

<template>
  <AppModal />
  <div class="toast" :class="{ show: ui.toast.show }">{{ ui.toast.message }}</div>

  <div class="wrap">
    <header class="appHead">
      <div>
        <h1>要塞・ドラゴン トラッカー</h1>
        <p class="sub">攻撃可能(浮上)になる順に自動で並びます</p>
      </div>
      <button class="syncChip" :class="chip.state" type="button" @click="onChip">
        <span class="dot"></span>{{ chip.text }}
      </button>
    </header>

    <nav class="tabs">
      <button
        v-for="t in tabs"
        :key="t.id"
        class="tabBtn"
        :class="{ active: ui.tab === t.id }"
        @click="ui.goTab(t.id)"
      >
        {{ t.label }}
        <span v-if="t.id === 'ready' && tracker.readyList.length" class="count" style="display:inline-block;">{{ tracker.readyList.length }}</span>
      </button>
    </nav>

    <MainTab v-show="ui.tab === 'main'" />
    <ReadyTab v-show="ui.tab === 'ready'" />
    <StatsTab v-show="ui.tab === 'stats'" />
    <SettingsTab v-show="ui.tab === 'settings'" />
  </div>
</template>
