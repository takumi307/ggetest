<script setup>
import { computed } from 'vue'
import { calendarMonth, monthDate } from '@/utils/rubyAnalytics'
import { getMonthKey } from '@/utils/helpers'

const props = defineProps({ month: { type: String, required: true }, today: { type: String, required: true }, selected: String, daily: { type: Map, required: true } })
const emit = defineEmits(['month', 'select'])
const weekdays = ['日', '月', '火', '水', '木', '金', '土']
const calendar = computed(() => calendarMonth(props.month, props.daily))
const monthLabel = computed(() => `${props.month.slice(0, 4)}年${Number(props.month.slice(5))}月`)
const total = computed(() => calendar.value.days.reduce((sum, day) => sum + day.ruby, 0))
const peak = computed(() => Math.max(0, ...calendar.value.days.map((day) => day.ruby)))
const formatter = new Intl.NumberFormat('ja-JP', { notation: 'compact', maximumFractionDigits: 1 })

function move(offset) { emit('month', getMonthKey(monthDate(props.month, offset))) }
function level(ruby) { return ruby ? Math.ceil(3 * ruby / peak.value) : 0 }
</script>

<template>
  <section class="statsBox analytics-section" aria-labelledby="ruby-calendar-heading">
    <div class="calendar-navigation">
      <button class="textAction" type="button" aria-label="前の月" @click="move(-1)">‹</button>
      <h3 id="ruby-calendar-heading">{{ monthLabel }}</h3>
      <button class="textAction" type="button" aria-label="次の月" @click="move(1)">›</button>
    </div>
    <p class="miniLabel calendar-caption">月の合計 {{ total.toLocaleString() }} ルビー。日付を選ぶと、その日の集計と履歴を表示します。</p>
    <div class="ruby-calendar">
      <span v-for="day in weekdays" :key="day" class="calendar-weekday">{{ day }}</span>
      <span v-for="offset in calendar.offset" :key="`blank-${offset}`" aria-hidden="true"></span>
      <button v-for="day in calendar.days" :key="day.key" type="button" class="calendar-day" :data-level="level(day.ruby)"
        :aria-current="day.key === today ? 'date' : undefined" :aria-pressed="day.key === selected"
        :aria-label="`${monthLabel}${day.day}日、${day.ruby.toLocaleString()}ルビー、${day.count}件`" @click="emit('select', day.key)">
        <strong>{{ day.day }}</strong>
        <span v-if="day.ruby">{{ formatter.format(day.ruby) }}</span>
      </button>
    </div>
    <p v-if="peak" class="miniLabel calendar-legend">色が濃いほど、その月の中で獲得量が多い日です。</p>
    <button v-if="month !== today.slice(0, 7)" class="textAction" type="button" @click="emit('month', today.slice(0, 7))">今月に戻る</button>
  </section>
</template>
