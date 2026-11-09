<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useTrackerStore } from '@/stores/trackerStore'
import { useSyncStore } from '@/stores/syncStore'
import { useUiStore } from '@/stores/uiStore'
import { CHANNEL_IDS, SYNC_CHANNELS } from '@/utils/constants'
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
const syncDetailsOpen = ref(false)
const configuredChannels = computed(() => CHANNEL_IDS.filter(sync.isConfigured))

let tickTimer = null
let syncTimer = null

/* 画面が見えるようになったら同期の時間を確認し、見えなくなるとき（別アプリへ切り替え・閉じる）は未送信の変更を1回送る */
function checkSync() {
  sync.updateNetworkStatus()
  sync.autoSyncIfNeeded()
}
function onVisibility() {
  if (document.visibilityState === 'visible') checkSync()
  else sync.flushOnLeave()
}
function onPageHide() {
  sync.flushOnLeave()
}

onMounted(() => {
  tickTimer = setInterval(tracker.tick, 1000) // 残り時間の表示更新
  syncTimer = setInterval(sync.autoSyncIfNeeded, 5000) // 同期の期限を確認するだけ。通信は期限に達したときに行う
  window.addEventListener('online', sync.updateNetworkStatus)
  window.addEventListener('offline', sync.updateNetworkStatus)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('pageshow', checkSync)
  window.addEventListener('focus', checkSync)
  checkSync()
  sync.loadAllNotify() // 通知設定（サーバー保存）を読み込む
})
onBeforeUnmount(() => {
  clearInterval(tickTimer)
  clearInterval(syncTimer)
  window.removeEventListener('online', sync.updateNetworkStatus)
  window.removeEventListener('offline', sync.updateNetworkStatus)
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('pagehide', onPageHide)
  window.removeEventListener('pageshow', checkSync)
  window.removeEventListener('focus', checkSync)
})
</script>

<template>
  <AppModal />
  <div class="toast" :class="{ show: ui.toast.show }" role="status">{{ ui.toast.show ? ui.toast.message : '' }}</div>

  <div class="wrap">
    <header class="appHead">
      <div>
        <h1>GGE Tracker</h1>
        <p class="sub">攻撃可能(浮上)になる順に自動で並びます</p>
      </div>
      <button
        class="syncChip" :class="chip.state" type="button"
        :aria-expanded="syncDetailsOpen" aria-controls="sync-details" @click="syncDetailsOpen = !syncDetailsOpen"
      >
        <span class="dot" aria-hidden="true"></span>
        <span>
          <span role="status">{{ chip.text }}</span>
          <small v-if="chip.lastSync">最終同期 {{ chip.lastSync }}</small>
        </span>
      </button>
    </header>
    <div v-show="syncDetailsOpen" id="sync-details" class="syncDetails">
      <p v-for="id in configuredChannels" :key="id">{{ SYNC_CHANNELS[id].name }}：{{ sync.statusText(id) }}</p>
      <button v-if="configuredChannels.length" class="btnGhost" type="button" :disabled="!sync.canSyncNow()" @click="sync.syncAll()">今すぐ同期</button>
      <button v-else class="btnGhost" type="button" @click="ui.goTab('settings')">接続設定を開く</button>
    </div>
    <div class="syncNotice" role="status">{{ sync.updateNotice }}</div>

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
