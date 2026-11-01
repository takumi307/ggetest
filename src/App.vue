<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useTrackerStore } from '@/stores/trackerStore'
import { useSyncStore } from '@/stores/syncStore'
import { useUiStore } from '@/stores/uiStore'
import AppModal from '@/components/AppModal.vue'
import MainTab from '@/components/MainTab.vue'
import ReadyTab from '@/components/ReadyTab.vue'
import StatsTab from '@/components/StatsTab.vue'

const tracker = useTrackerStore()
const sync = useSyncStore()
const ui = useUiStore()

const tab = ref('main')
const tabs = [
  { id: 'main', label: '一覧' },
  { id: 'ready', label: '攻撃可能' },
  { id: 'stats', label: '集計' }
]

let tickTimer = null
let syncTimer = null
function onVisible() {
  if (document.visibilityState === 'visible') sync.autoSyncIfNeeded()
}

onMounted(() => {
  tickTimer = setInterval(tracker.tick, 1000) // 残り時間の表示更新
  syncTimer = setInterval(sync.autoSyncIfNeeded, 30000) // 5分おきの同期チェック（30秒ごとに「時間になったか」確認）
  document.addEventListener('visibilitychange', onVisible)
  sync.autoSyncIfNeeded()
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
    <h1>要塞・ドラゴン トラッカー</h1>
    <p class="sub">攻撃可能(浮上)になる順に自動で並びます</p>

    <div class="tabs">
      <button
        v-for="t in tabs"
        :key="t.id"
        class="tabBtn"
        :class="{ active: tab === t.id }"
        @click="tab = t.id"
      >
        {{ t.label }}
        <span v-if="t.id === 'ready' && tracker.readyList.length" class="count" style="display:inline-block;">{{ tracker.readyList.length }}</span>
      </button>
    </div>

    <MainTab v-show="tab === 'main'" />
    <ReadyTab v-show="tab === 'ready'" />
    <StatsTab v-show="tab === 'stats'" />
  </div>
</template>