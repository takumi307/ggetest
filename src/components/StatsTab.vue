<script setup>
import { computed, ref, watch } from 'vue'
import { useTrackerStore } from '@/stores/trackerStore'
import { typeLabel, formatClock, getLocalDateKey, getMonthKey, lastMonthKey } from '@/utils/helpers'
import { summarizeRubyHistory, rubyTrend, trendBucketKey, trendLabel } from '@/utils/rubyAnalytics'
import StatsTrend from './StatsTrend.vue'
import StatsCalendar from './StatsCalendar.vue'

const tracker = useTrackerStore()
const periods = [
  ['today', '今日'], ['month', '今月'], ['lastMonth', '先月'], ['all', '全期間'], ['date', '指定日']
]
const views = [['trend', 'グラフ'], ['calendar', 'カレンダー']]
const view = ref('trend')
const today = computed(() => getLocalDateKey(tracker.now))
const month = ref(getMonthKey(tracker.now))
const bucket = ref(null)
const pageSize = 20
const historyLimit = ref(pageSize)
const historyHeading = ref(null)
const summary = computed(() => summarizeRubyHistory(tracker.statsList, tracker.isCountedHistory))
const allDaily = computed(() => summarizeRubyHistory(tracker.attackHistory, tracker.isCountedHistory).days)
const trend = computed(() => rubyTrend(tracker.statsPeriod, today.value, tracker.statsList, tracker.isCountedHistory))
const filteredHistory = computed(() => bucket.value == null ? tracker.statsList :
  tracker.statsList.filter((entry) => trendBucketKey(entry.at, trend.value.unit) === bucket.value))
const selectedLabel = computed(() => bucket.value == null ? tracker.statsPeriodLabel() : trendLabel(bucket.value, trend.value.unit))

watch([() => tracker.statsPeriod, () => tracker.statsDate], ([period, date]) => {
  bucket.value = null
  if (period === 'date' && date) month.value = date.slice(0, 7)
  else if (period === 'lastMonth') month.value = lastMonthKey(tracker.now)
  else if (period !== 'all') month.value = today.value.slice(0, 7)
})
watch(bucket, () => { historyLimit.value = pageSize })
watch(() => tracker.statsList, () => { historyLimit.value = pageSize })

function selectDay(date) {
  tracker.statsDate = date
  tracker.statsPeriod = 'date'
  bucket.value = null
}

function selectBucket(key) { bucket.value = bucket.value === key ? null : key }
function showHistory() {
  historyHeading.value?.scrollIntoView({ block: 'start' })
  historyHeading.value?.focus({ preventScroll: true })
}
</script>

<template>
  <div class="ruby-analytics">
    <section class="statsBox analytics-section" aria-labelledby="ruby-overview">
      <h2 id="ruby-overview">ルビー獲得集計</h2>
      <div class="periodBtns" role="group" aria-label="集計期間">
        <button
          v-for="[key, label] in periods"
          :key="key"
          class="periodBtn"
          type="button"
          :class="{ active: tracker.statsPeriod === key }"
          :aria-pressed="tracker.statsPeriod === key"
          @click="tracker.statsPeriod = key"
        >{{ label }}</button>
      </div>
      <div v-if="tracker.statsPeriod === 'date'" class="field">
        <label for="ruby-stats-date">表示日</label>
        <input id="ruby-stats-date" v-model="tracker.statsDate" type="date">
      </div>
      <div class="statsGrid analytics-metrics">
        <div class="stat stat-primary"><div class="statLabel">獲得ルビー</div><div class="statValue">{{ tracker.rubyTotal.toLocaleString() }}</div></div>
        <div class="stat"><div class="statLabel">1日平均</div><div class="statValue">{{ tracker.rubyAverage.toLocaleString() }}</div></div>
        <div class="stat"><div class="statLabel">獲得回数</div><div class="statValue">{{ summary.count.toLocaleString() }} <small>回</small></div></div>
        <div class="stat"><div class="statLabel">獲得した日</div><div class="statValue">{{ summary.days.size.toLocaleString() }} <small>日</small></div></div>
      </div>
      <p class="miniLabel analytics-comparison">{{ tracker.rubyMonthSummary }}</p>
    </section>

    <div class="periodBtns analytics-views" role="group" aria-label="分析表示">
      <button v-for="[key, label] in views" :key="key" type="button" class="periodBtn"
        :class="{ active: view === key }" :aria-pressed="view === key" @click="view = key; bucket = null">{{ label }}</button>
    </div>
    <StatsTrend v-if="view === 'trend'" :trend="trend" :selected="bucket" @select="selectBucket" />
    <StatsCalendar v-else :month="month" :today="today" :selected="tracker.statsPeriod === 'date' ? tracker.statsDate : undefined"
      :daily="allDaily" @month="month = $event" @select="selectDay" />

    <section v-if="summary.types.length" class="statsBox analytics-section" aria-labelledby="ruby-breakdown">
      <div class="analytics-heading">
        <h3 id="ruby-breakdown">種類別の内訳</h3>
        <button class="textAction" type="button" @click="showHistory">履歴へ ↓</button>
      </div>
      <ul class="ruby-breakdown">
        <li v-for="item in summary.types" :key="item.type">
          <div><strong>{{ typeLabel(item.type) || '種類不明' }}</strong><span>{{ item.count.toLocaleString() }}回 · <b>{{ item.ruby.toLocaleString() }}</b> ルビー</span></div>
          <progress :value="item.ruby" :max="summary.total" :aria-label="`${typeLabel(item.type) || '種類不明'}の獲得割合`"></progress>
        </li>
      </ul>
    </section>

    <section aria-labelledby="ruby-history-heading">
      <div class="analytics-heading history-heading">
        <div>
          <h3 id="ruby-history-heading" ref="historyHeading" tabindex="-1">ルビー獲得履歴</h3>
          <p class="miniLabel">{{ selectedLabel }} · {{ filteredHistory.length.toLocaleString() }}件</p>
        </div>
        <button v-if="bucket !== null" class="textAction" type="button" @click="bucket = null">絞り込み解除</button>
      </div>
      <p v-if="!filteredHistory.length" class="empty list-empty">この期間の記録はありません</p>
      <article v-for="x in filteredHistory.slice(0, historyLimit)" :key="x.id" class="historyCard analytics-history-item">
        <div>
          <div v-if="tracker.isCountedHistory(x)" class="historyResult success">+{{ Number(x.ruby).toLocaleString() }} ルビー</div>
          <div v-else class="historyResult taken">取られた <small>（集計対象外）</small></div>
          <div class="historyMeta">{{ typeLabel(x.type) || '種類不明' }}<template v-if="x.label"> / {{ x.label }}</template> · X:{{ x.x }} / Y:{{ x.y }} · {{ formatClock(x.at) }}</div>
        </div>
        <button class="textAction connection-disconnect" type="button" @click="tracker.deleteHistory(x.id)">削除</button>
      </article>
      <button v-if="filteredHistory.length > historyLimit" class="addBtn secondary" type="button" @click="historyLimit += pageSize">履歴をさらに表示</button>
    </section>

    <details class="statsBox analytics-reset">
      <summary>記録のリセット</summary>
      <p class="miniLabel">同期を設定している場合、削除は他の端末にも反映されます。削除した記録は元に戻せません。</p>
      <div class="btnRow"><button class="btnDanger" type="button" @click="tracker.resetHistory('view')">「{{ tracker.statsPeriodLabel() }}」の記録をすべて削除</button></div>
      <div class="btnRow"><button class="btnDanger" type="button" @click="tracker.resetHistory('all')">全期間の記録を削除</button></div>
    </details>
  </div>
</template>
