<script setup>
import { useTrackerStore } from '@/stores/trackerStore'
import { TYPE_OPTIONS } from '@/utils/constants'
import EntryCard from './EntryCard.vue'

const tracker = useTrackerStore()
</script>

<template>
  <div>
    <p class="miniLabel" style="margin-bottom:12px;">新規登録した座標、攻撃可能(浮上)になったものがここに表示されます。ドラゴン・要塞は「取れた！記録する」で記録できます。小アクア・大アクアは時間管理のみ行い、獲得記録は行いません。</p>
    <div class="filterRow" style="margin-bottom:12px;">
      <select v-model="tracker.readyTypeFilter" aria-label="攻撃可能タブの種類で絞り込み">
        <option value="all">すべての種類</option>
        <option v-for="t in TYPE_OPTIONS" :key="t.value" :value="t.value">{{ t.label }}</option>
      </select>
    </div>
    <p v-if="tracker.nearWarning" class="warnNote">{{ tracker.nearWarning }}</p>
    <div>
      <p v-if="tracker.readyList.length === 0" class="empty">攻撃可能(浮上)なものはありません</p>
      <EntryCard v-for="e in tracker.readyList" :key="e.id" :entry="e" ready />
    </div>
  </div>
</template>