<script setup>
import { ref, computed, watch } from 'vue'
import { useTrackerStore } from '@/stores/trackerStore'
import { useSyncStore } from '@/stores/syncStore'
import { useUiStore } from '@/stores/uiStore'
import { TYPE_OPTIONS, SORT_OPTIONS } from '@/utils/constants'
import { typeLabel, formatDuration } from '@/utils/helpers'
import EntryCard from './EntryCard.vue'
import AddPanel from './AddPanel.vue'
import BulkPanel from './BulkPanel.vue'
import BackupPanel from './BackupPanel.vue'

const tracker = useTrackerStore()
const sync = useSyncStore()
const ui = useUiStore()

const panel = ref(null)
const panelDialog = ref(null)
const bulkType = ref('wildFortress')
const panelTitles = { add: '新規登録', bulk: '複数登録', backup: 'データの引き継ぎ' }

watch(panel, (active) => {
  if (active && !panelDialog.value.open) panelDialog.value.showModal()
}, { flush: 'post' })

function closePanel(expected = panel.value) {
  if (panel.value === expected) panelDialog.value.close()
}

/* 次に攻撃可能になるもの（現在の絞り込みの中で最も早いもの） */
const next = computed(() =>
  tracker.waitingList.reduce((m, e) => (!m || tracker.attackableAt(e) < tracker.attackableAt(m) ? e : m), null)
)
const hasFilters = computed(() => !!tracker.searchQuery || tracker.typeFilter !== 'all' || tracker.sortMode !== 'timeAsc')
const lostCount = computed(() => tracker.entries.filter(sync.isAquaLost).length)
</script>

<template>
  <div>
    <div v-if="!sync.anyConfigured()" class="banner">
      <span><strong>共有サーバーに未接続</strong><br>ほかの人とタイマーを共有するには接続設定が必要です。</span>
      <button type="button" @click="ui.goTab('settings')">接続設定</button>
    </div>

    <button class="addBtn" type="button" aria-haspopup="dialog" @click="panel = 'add'">＋ 新規登録</button>
    <div class="list-actions">
      <button class="addBtn secondary" type="button" aria-haspopup="dialog" @click="panel = 'bulk'">複数登録</button>
      <button class="addBtn secondary" type="button" aria-haspopup="dialog" @click="panel = 'backup'">引き継ぎ</button>
    </div>

    <dialog ref="panelDialog" class="action-dialog" aria-labelledby="action-dialog-title" @close="panel = null">
      <header class="action-dialog-header">
        <h2 id="action-dialog-title">{{ panelTitles[panel] }}</h2>
        <button class="textAction" type="button" aria-label="ダイアログを閉じる" autofocus @click="closePanel()">閉じる</button>
      </header>
      <div :key="panel" class="action-dialog-body">
        <AddPanel v-if="panel === 'add'" @close="closePanel('add')" />
        <BulkPanel v-else-if="panel === 'bulk'" v-model="bulkType" @close="closePanel('bulk')" />
        <BackupPanel v-else-if="panel === 'backup'" @close="closePanel('backup')" />
      </div>
      <div class="toast" :class="{ show: ui.toast.show }" role="status">{{ ui.toast.show ? ui.toast.message : '' }}</div>
    </dialog>

    <div v-if="next" class="nextBar">
      <div>
        <div class="next-label">{{ next.type === 'aqua' || next.type === 'smallAqua' ? '次に浮上' : '次に攻撃可能' }}</div>
        <b>{{ tracker.entryLabel(next) || typeLabel(next.type) }}</b> <span>({{ next.x }}, {{ next.y }})</span>
      </div>
      <strong class="next-time">{{ formatDuration(tracker.attackableAt(next) - tracker.now) }}</strong>
    </div>

    <div class="searchBox">
      <input v-model="tracker.searchQuery" type="search" aria-label="座標・名前で検索" placeholder="座標・名前で検索（例: 662 715）">
      <button v-if="hasFilters" class="textAction" type="button" @click="tracker.resetFilters()">リセット</button>
    </div>
    <div class="filterRow list-filters">
      <select v-model="tracker.typeFilter" aria-label="種類で絞り込み">
        <option value="all">すべての種類</option>
        <option v-for="t in TYPE_OPTIONS" :key="t.value" :value="t.value">{{ t.label }}</option>
      </select>
      <select v-model="tracker.sortMode" aria-label="並び順">
        <option v-for="o in SORT_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>
    <p v-if="tracker.nearWarning" class="warnNote">{{ tracker.nearWarning }}</p>

    <section class="lost-section" aria-labelledby="lost-heading">
      <h2 id="lost-heading" class="list-heading">ロストしたアクア <span>{{ lostCount }} 件</span></h2>
      <p v-if="lostCount && !tracker.lostList.length" class="miniLabel">現在の表示条件に合うロストはありません。</p>
      <EntryCard v-for="e in tracker.lostList" :key="e.id" :entry="e" />
    </section>

    <h2 class="list-heading">待ち一覧 <span>{{ tracker.waitingList.length }} 件</span></h2>
    <div>
      <div v-if="tracker.waitingList.length === 0" class="empty list-empty">
        <strong>{{ tracker.entries.length === 0 ? 'まだ登録がありません' : hasFilters ? '絞り込み条件に合う待ち対象がありません' : '待ち時間のある対象はありません' }}</strong>
        <p v-if="tracker.entries.length === 0">上の「新規登録」から座標を追加できます。</p>
        <button v-else-if="hasFilters" class="textAction" type="button" @click="tracker.resetFilters()">検索・絞り込みをリセット</button>
        <button v-else class="textAction" type="button" @click="ui.goTab('ready')">攻撃可能タブを開く</button>
      </div>
      <EntryCard v-for="e in tracker.waitingList" :key="e.id" :entry="e" />
    </div>
  </div>
</template>
