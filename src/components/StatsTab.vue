<script setup>
import { useTrackerStore } from '@/stores/trackerStore'
import { typeLabel, formatClock } from '@/utils/helpers'

const tracker = useTrackerStore()
const periods = [
  ['today', '今日'], ['month', '今月'], ['lastMonth', '先月'], ['all', '全期間'], ['date', '指定日']
]
</script>

<template>
  <div>
    <div class="statsBox">
      <h2 style="font-size:15px;margin:0 0 10px;">ルビー獲得集計</h2>
      <div class="periodBtns">
        <button
          v-for="[key, label] in periods"
          :key="key"
          class="periodBtn"
          :class="{ active: tracker.statsPeriod === key }"
          @click="tracker.statsPeriod = key"
        >{{ label }}</button>
      </div>
      <div v-if="tracker.statsPeriod === 'date'" class="field">
        <label>表示日</label>
        <input v-model="tracker.statsDate" type="date">
      </div>
      <div class="statsGrid">
        <div class="stat"><div class="statLabel">獲得ルビー</div><div class="statValue">{{ tracker.rubyTotal.toLocaleString() }}</div></div>
        <div class="stat"><div class="statLabel">1日平均獲得ルビー</div><div class="statValue">{{ tracker.rubyAverage.toLocaleString() }}</div></div>
      </div>
      <p class="miniLabel" style="margin:8px 0 0;text-align:center;">{{ tracker.rubyMonthSummary }}</p>
    </div>

    <div class="sectionTitle">ルビー獲得履歴</div>
    <div>
      <p v-if="!tracker.statsList.length" class="empty">この期間の記録はありません</p>
      <div v-for="x in tracker.statsList" :key="x.id" class="historyCard">
        <div v-if="tracker.isCountedHistory(x)" class="historyResult">+{{ (Number(x.ruby) || 0).toLocaleString() }}ルビー</div>
        <div v-else class="historyResult taken">取られた <span style="font-size:11px;font-weight:600;">（集計対象外）</span></div>
        <div class="historyMeta">{{ typeLabel(x.type) }}<template v-if="x.label"> / {{ x.label }}</template>　X:{{ x.x }} / Y:{{ x.y }}　{{ formatClock(x.at) }}</div>
        <div class="cardBtns" style="margin-top:8px;">
          <button class="btnDelete" @click="tracker.deleteHistory(x.id)">削除</button>
        </div>
      </div>
    </div>

    <div class="sectionTitle" style="margin-top:18px;">記録のリセット</div>
    <p class="miniLabel">削除した記録は元に戻せません。「端末同期」で要塞・ドラゴンの同期を設定している場合は、他の端末の記録も削除されます（次の同期のときに反映）。</p>
    <button class="btnDelete" type="button" style="width:100%;padding:12px;margin-top:6px;" @click="tracker.resetHistory('view')">表示中の期間の記録を削除</button>
    <button class="btnDelete" type="button" style="width:100%;padding:12px;margin-top:8px;" @click="tracker.resetHistory('all')">ルビーの記録をすべてリセット</button>
  </div>
</template>