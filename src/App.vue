<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useTrackerStore } from '@/stores/trackerStore'
import { useSyncStore } from '@/stores/syncStore'
import { useUiStore } from '@/stores/uiStore'
import AppModal from '@/components/AppModal.vue'
import MainTab from '@/components/MainTab.vue'
import ReadyTab from '@/components/ReadyTab.vue'
import StatsTab from '@/components/StatsTab.vue'
import SettingsTab from '@/components/SettingsTab.vue'
import EntryCard from '@/components/EntryCard.vue'
import { ALL_TYPES } from '@/utils/constants'
import { aquaKey } from '@/utils/helpers'

const tracker = useTrackerStore()
const sync = useSyncStore()
const ui = useUiStore()

const tabs = [
  { id: 'main', label: '待ち一覧' },
  { id: 'ready', label: '攻撃可能' },
  { id: 'stats', label: '集計' },
  { id: 'settings', label: '設定' }
]

const target = ref(null)
const targetEntry = computed(() => target.value && tracker.entries.find((entry) => aquaKey(entry) === aquaKey(target.value)))
const targetReady = computed(() => !!targetEntry.value && !sync.isAquaLost(targetEntry.value) &&
  tracker.attackableAt(targetEntry.value) <= tracker.now)
const targetChannel = computed(() => target.value && sync.chanIdOfType(target.value.type))
const activeTab = computed(() => target.value ? (targetReady.value ? 'ready' : 'main') : ui.tab)

function syncTarget() {
  const channel = targetChannel.value
  if (sync.isConfigured(channel) && !sync.runtime[channel].syncing) sync.syncNow(channel, 'silent')
}

function readTargetLink() {
  const key = new URLSearchParams(window.location.hash.slice(1)).get('target')
  const [type, x, y, extra] = key?.split('|') ?? []
  target.value = ALL_TYPES.includes(type) && extra === undefined && x?.trim() && y?.trim() &&
    Number.isFinite(Number(x)) && Number.isFinite(Number(y)) ? { type, x: Number(x), y: Number(y) } : null
  if (target.value) {
    tracker.cancelEdit()
    window.scrollTo(0, 0)
    syncTarget()
  }
}

function switchTab(tab) {
  if (target.value) {
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
    target.value = null
  }
  ui.goTab(tab)
}

let swipeStart = null
function startSwipe(event) {
  swipeStart = null
  if (event.touches.length !== 1 || event.target.closest('button, a, input, select, textarea, label, dialog, .trend-scroll, [contenteditable]')) return
  const { clientX, clientY } = event.touches[0]
  if (clientX < 12 || clientX > window.innerWidth - 12) return
  swipeStart = { x: clientX, y: clientY }
}

function moveSwipe(event) {
  if (!swipeStart) return
  const touch = event.touches[0]
  if (event.touches.length !== 1 || (Math.abs(touch.clientY - swipeStart.y) > 24 &&
    Math.abs(touch.clientY - swipeStart.y) > Math.abs(touch.clientX - swipeStart.x))) swipeStart = null
}

function finishSwipe(event) {
  const start = swipeStart
  swipeStart = null
  if (!start || event.touches.length || window.getSelection()?.toString()) return
  const touch = event.changedTouches[0]
  if (!touch) return
  const x = touch.clientX - start.x
  const y = touch.clientY - start.y
  if (Math.abs(x) < 50 || Math.abs(x) < Math.abs(y) * 1.6) return
  const index = tabs.findIndex((tab) => tab.id === activeTab.value)
  if (index < 0) return
  const direction = x < 0 ? -1 : 1
  const nextIndex = (index + direction + tabs.length) % tabs.length
  switchTab(tabs[nextIndex].id)
}

const chip = computed(() => sync.summary())
function onChip() {
  if (chip.value.state === 'unset') ui.goTab('settings')
  else sync.syncAll()
}

let tickTimer = null

/* 画面が見えるようになったら同期の時間を確認し、見えなくなるとき（別アプリへ切り替え・閉じる）は未送信の変更を1回送る */
function onVisibility() {
  if (document.visibilityState === 'visible') sync.autoSyncIfNeeded()
  else onPageHide()
}
function onPageHide() {
  tracker.commitTimerUpdate()
  sync.flushOnLeave()
}

onMounted(() => {
  tickTimer = setInterval(() => {
    tracker.tick()
    sync.autoSyncIfNeeded()
  }, 1000)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('hashchange', readTargetLink)
  readTargetLink()
  sync.autoSyncIfNeeded()
  sync.loadAllNotify() // 通知設定（サーバー保存）を読み込む
})
onBeforeUnmount(() => {
  clearInterval(tickTimer)
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('pagehide', onPageHide)
  window.removeEventListener('hashchange', readTargetLink)
})
</script>

<template>
  <AppModal />
  <div class="toast" :class="{ show: ui.toast.show }" role="status">{{ ui.toast.show ? ui.toast.message : '' }}</div>
  <div v-if="tracker.pendingTimerUpdate" class="timer-undo">
    <span role="status">タイマーを更新しました</span>
    <button type="button" @click="tracker.undoTimerUpdate()">元に戻す</button>
  </div>

  <div class="wrap">
    <header class="appHead">
      <div>
        <h1>GGETracker</h1>
        <p class="sub">要塞・ドラゴン・アクア</p>
      </div>
      <button class="syncChip" :class="chip.state" type="button" :disabled="chip.state === 'syncing'"
        :aria-label="chip.state === 'unset' ? '未接続。接続設定を開く' : `${chip.text}。今すぐ同期`" @click="onChip">
        <span class="dot"></span>{{ chip.text }}
      </button>
    </header>

    <nav class="tabs" aria-label="メインメニュー">
      <button
        v-for="t in tabs"
        :key="t.id"
        class="tabBtn"
        type="button"
        :class="{ active: activeTab === t.id }"
        :aria-current="activeTab === t.id ? 'page' : undefined"
        @click="switchTab(t.id)"
      >
        {{ t.label }}
        <span v-if="t.id === 'ready' && tracker.readyList.length" class="count" style="display:inline-block;">{{ tracker.readyList.length }}</span>
      </button>
    </nav>

    <main @touchstart.passive="startSwipe" @touchmove.passive="moveSwipe" @touchend.passive="finishSwipe" @touchcancel="swipeStart = null">
      <section v-if="target" aria-labelledby="linked-target-heading">
        <div class="linked-target-heading">
          <h2 id="linked-target-heading" class="list-heading">リンク先の対象</h2>
          <button type="button" class="textAction" @click="switchTab(activeTab)">一覧に戻る</button>
        </div>
        <EntryCard v-if="targetEntry" :key="aquaKey(targetEntry)" :entry="targetEntry" :ready="targetReady" />
        <div v-else class="empty list-empty" role="status">
          <p v-if="sync.runtime[targetChannel].syncing">対象を同期しています…</p>
          <template v-else-if="!sync.isConfigured(targetChannel)">
            <p>対象を表示するには、共有サーバーに接続してください。</p>
            <button type="button" class="textAction" @click="switchTab('settings')">接続設定を開く</button>
          </template>
          <template v-else>
            <p>{{ sync.runtime[targetChannel].lastError ? '対象を同期できませんでした。' : 'この種類・座標は現在のユーザーの一覧にありません。' }}</p>
            <button type="button" class="textAction" @click="syncTarget">もう一度同期</button>
          </template>
        </div>
      </section>
      <MainTab v-show="!target && ui.tab === 'main'" />
      <ReadyTab v-show="!target && ui.tab === 'ready'" />
      <StatsTab v-show="!target && ui.tab === 'stats'" />
      <SettingsTab v-show="!target && ui.tab === 'settings'" />
      <div class="tab-swipe-space" aria-hidden="true"></div>
    </main>
  </div>
</template>
