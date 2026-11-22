<script setup>
import { computed } from 'vue'
import { useTrackerStore } from '@/stores/trackerStore'
import { useSyncStore } from '@/stores/syncStore'
import { TYPE_OPTIONS } from '@/utils/constants'
import { isAquaFamily } from '@/utils/helpers'
import EntryCard from './EntryCard.vue'

const tracker = useTrackerStore()
const sync = useSyncStore()
const typeOptions = computed(() => tracker.readyNearestOnly ? TYPE_OPTIONS.filter((type) => isAquaFamily(type.value)) : TYPE_OPTIONS)
const hasFilters = computed(() => !!tracker.searchQuery.trim() || tracker.readyTypeFilter !== 'all' || tracker.readyNearestOnly)

function resetFilters() {
  tracker.searchQuery = ''
  tracker.readyTypeFilter = 'all'
  tracker.readyNearestOnly = false
}

function toggleNearest(event) {
  const enabled = event.target.checked
  if (enabled && !isAquaFamily(tracker.readyTypeFilter)) tracker.readyTypeFilter = 'all'
  tracker.readyNearestOnly = enabled
}
</script>

<template>
  <div>
    <h2 class="list-heading">攻撃可能・浮上中 <span>{{ tracker.readyList.length }} 件</span></h2>
    <div class="searchBox">
      <input v-model="tracker.searchQuery" type="search" aria-label="座標・名前で検索" placeholder="座標・名前で検索（例: 662 715）">
      <button v-if="hasFilters" class="textAction" type="button" @click="resetFilters">絞り込み解除</button>
    </div>
    <div class="filterRow ready-filters">
      <select v-model="tracker.readyTypeFilter" aria-label="攻撃可能タブの種類で絞り込み">
        <option value="all">{{ tracker.readyNearestOnly ? '大・小アクア' : 'すべての種類' }}</option>
        <option v-for="t in typeOptions" :key="t.value" :value="t.value">{{ t.label }}</option>
      </select>
      <label class="nearest-filter"><input type="checkbox" :checked="tracker.readyNearestOnly" @change="toggleNearest">自分が最寄り</label>
    </div>
    <p v-if="tracker.nearWarning" class="warnNote">{{ tracker.nearWarning }}</p>
    <div>
      <p v-if="tracker.readyList.length === 0" class="empty">
        <template v-if="tracker.readyNearestOnly && !sync.stormProfile()?.enabled">設定で「最寄り比較に参加する」をオンにして同期してください。</template>
        <template v-else-if="tracker.searchQuery.trim() || tracker.readyTypeFilter !== 'all'">絞り込み条件に合う対象はありません。</template>
        <template v-else-if="tracker.readyNearestOnly">自分が最寄りの浮上中アクアはありません。</template>
        <template v-else>攻撃可能(浮上)なものはありません</template>
      </p>
      <EntryCard v-for="e in tracker.readyList" :key="e.id" :entry="e" ready />
    </div>
  </div>
</template>
