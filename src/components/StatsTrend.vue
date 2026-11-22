<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { trendLabel } from '@/utils/rubyAnalytics'
import { useUiStore } from '@/stores/uiStore'

const props = defineProps({ trend: { type: Object, required: true }, selected: String })
const emit = defineEmits(['select'])
const ui = useUiStore()
const scroller = ref(null)
const peak = computed(() => Math.max(0, ...props.trend.bins.map((bin) => bin.ruby)))
const unitName = computed(() => ({ hour: '時間帯別', day: '日別', month: '月別', year: '年別' })[props.trend.unit])
const active = computed(() => props.trend.bins.find((bin) => bin.key === props.selected))

function showRecentBar() {
  if (ui.tab !== 'stats' || !scroller.value) return
  const index = props.trend.bins.findLastIndex((bin) => bin.ruby > 0)
  const bar = scroller.value.querySelectorAll('.trend-bin')[index]
  if (bar) scroller.value.scrollLeft = Math.max(0, bar.offsetLeft + bar.offsetWidth - scroller.value.clientWidth + 8)
}

onMounted(showRecentBar)
watch([() => ui.tab, () => props.trend.unit, () => props.trend.bins[0]?.key], showRecentBar, { flush: 'post' })

function axisLabel(key) {
  if (props.trend.unit === 'hour') return Number(key)
  if (props.trend.unit === 'day') return Number(key.slice(8))
  if (props.trend.unit === 'month') return `${key.slice(2, 4)}/${Number(key.slice(5))}`
  return key
}
</script>

<template>
  <section class="statsBox analytics-section" aria-labelledby="ruby-trend-heading">
    <div class="analytics-heading">
      <h3 id="ruby-trend-heading">{{ unitName }}の獲得ルビー</h3>
      <span v-if="peak" class="miniLabel">最大 {{ peak.toLocaleString() }}</span>
    </div>
    <p v-if="!peak" class="miniLabel">この期間に獲得したルビーはありません。</p>
    <template v-else>
      <p class="miniLabel">棒を選ぶと履歴を絞り込めます。グラフは横にスクロールできます。<template v-if="trend.unit === 'year'">獲得のあった年を表示します。</template></p>
      <div ref="scroller" class="trend-scroll">
        <div class="trend-grid" :style="{ '--bars': trend.bins.length }">
          <button v-for="bin in trend.bins" :key="bin.key" type="button" class="trend-bin"
            :aria-label="`${trendLabel(bin.key, trend.unit)}、${bin.ruby.toLocaleString()}ルビー、${bin.count}件`"
            :aria-pressed="bin.key === selected" @click="emit('select', bin.key)">
            <span class="trend-track" aria-hidden="true"><span class="trend-bar" :style="{ '--height': `${100 * bin.ruby / peak}%` }"></span></span>
            <span aria-hidden="true">{{ axisLabel(bin.key) }}</span>
          </button>
        </div>
      </div>
      <p v-if="active" class="analytics-selection" role="status">
        {{ trendLabel(active.key, trend.unit) }} · {{ active.ruby.toLocaleString() }} ルビー · {{ active.count }}件
      </p>
    </template>
  </section>
</template>
