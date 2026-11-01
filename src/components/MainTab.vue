<script setup>
import { ref } from 'vue'
import { useTrackerStore } from '@/stores/trackerStore'
import { TYPE_OPTIONS, SORT_OPTIONS } from '@/utils/constants'
import EntryCard from './EntryCard.vue'
import AddPanel from './AddPanel.vue'
import BulkPanel from './BulkPanel.vue'
import BackupPanel from './BackupPanel.vue'
import SettingsPanel from './SettingsPanel.vue'
import SyncButtons from './SyncButtons.vue'

const tracker = useTrackerStore()
const showAdd = ref(false)
const showBulk = ref(false)
const showBackup = ref(false)
</script>

<template>
  <div>
    <button class="addBtn" @click="showAdd = true">＋ 新規登録</button>
    <div style="display:flex; gap:8px; margin-bottom:14px;">
      <button class="addBtn secondary" style="margin-bottom:0;" @click="showBulk = true">＋ 複数登録</button>
      <button class="addBtn secondary" style="margin-bottom:0;" @click="showBackup = true">データの引き継ぎ</button>
    </div>
    <p class="statSub" style="text-align:center; margin:-6px 0 14px;">{{ tracker.countSummary }}</p>

    <SyncButtons />
    <SettingsPanel />

    <BulkPanel :open="showBulk" @close="showBulk = false" />
    <AddPanel :open="showAdd" @close="showAdd = false" />
    <BackupPanel :open="showBackup" @close="showBackup = false" />

    <div class="searchBox">
      <input v-model="tracker.searchQuery" type="text" placeholder="座標・ラベルで検索（例: 662 715）">
      <button class="addBtn secondary" style="width:72px; height:42px; margin:0;" @click="tracker.resetFilters()">クリア</button>
    </div>
    <div class="filterRow">
      <select v-model="tracker.typeFilter">
        <option value="all">すべての種類</option>
        <option v-for="t in TYPE_OPTIONS" :key="t.value" :value="t.value">{{ t.label }}</option>
      </select>
    </div>
    <div class="sortRow">
      <select v-model="tracker.sortMode">
        <option v-for="o in SORT_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>
    <p v-if="tracker.nearWarning" class="warnNote">{{ tracker.nearWarning }}</p>
    <p class="resultSummary">{{ tracker.resultSummary }}</p>

    <div>
      <p v-if="tracker.waitingList.length === 0" class="empty">
        <template v-if="tracker.entries.length === 0">まだ登録がありません<br>「＋ 新規登録」から追加してください</template>
        <template v-else>該当する登録はありません</template>
      </p>
      <EntryCard v-for="e in tracker.waitingList" :key="e.id" :entry="e" />
    </div>
  </div>
</template>