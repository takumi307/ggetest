<script setup>
import { ref, computed, nextTick, useId } from 'vue'
import { useTrackerStore } from '@/stores/trackerStore'
import { useSyncStore } from '@/stores/syncStore'
import { typeLabel, typeClass, isAquaFamily, formatClock, formatDuration } from '@/utils/helpers'
import EntryEditForm from './EntryEditForm.vue'

const props = defineProps({
  entry: { type: Object, required: true },
  ready: { type: Boolean, default: false }
})

const tracker = useTrackerStore()
const sync = useSyncStore()
const isAqua = computed(() => isAquaFamily(props.entry.type))
const lost = computed(() => sync.isAquaLost(props.entry))
const label = computed(() => tracker.entryLabel(props.entry))
const favorite = computed(() => tracker.isFavorite(props.entry))
const channel = computed(() => sync.chanIdOfType(props.entry.type))
const target = computed(() => sync.targetFor(props.entry))
const nearest = computed(() => isAqua.value ? sync.nearestFor(props.entry) : null)
const nearestNames = computed(() => nearest.value?.users.map((id) => id === tracker.userId ? '自分' : id).join('・'))
const dist = computed(() => tracker.coordDistance(props.entry))
const attackableAt = computed(() => tracker.attackableAt(props.entry))
const remainText = computed(() => formatDuration(attackableAt.value - tracker.now))
const winnerHistoryId = computed(() => tracker.winnerHistoryId(props.entry))
const cardId = useId()
const timerLabel = computed(() => isAqua.value ? '沈むまでの残り' : winnerHistoryId.value ? '120時間側の残り' : '24時間側の残り')
const statusLabel = computed(() => lost.value ? 'ロスト' : props.ready ? (isAqua.value ? '浮上中' : '攻撃可能') : (isAqua.value ? '浮上待ち' : 'クールタイム中'))

const rh = ref('')
const rm = ref('')
const rs = ref('')
const hInput = ref(null)
const hasTime = computed(() => rh.value !== '' || rm.value !== '' || (isAqua.value && rs.value !== ''))

function onUpdate() {
  if (tracker.updateReady(props.entry.id, rh.value, rm.value, rs.value)) {
    rh.value = ''
    rm.value = ''
    rs.value = ''
  }
}

async function onRecord() {
  const ok = await tracker.recordAttackResult(props.entry.id)
  if (!ok) return
  rh.value = ''
  rm.value = ''
  await nextTick()
  if (hInput.value) {
    hInput.value.focus()
    hInput.value.scrollIntoView({ block: 'nearest' })
  }
}

async function onUndoRecord() {
  const id = winnerHistoryId.value
  if (!id || !(await tracker.deleteHistory(id, true))) return
  rh.value = ''
  rm.value = ''
  await nextTick()
  hInput.value?.focus()
}
</script>

<template>
  <EntryEditForm v-if="tracker.inlineEditId === entry.id" :entry="entry" />

  <article v-else class="card entry-card" :class="{ ready, aqua: isAqua, lost }" :aria-labelledby="`${cardId}-title`">
    <div class="cardTop">
      <h3 :id="`${cardId}-title`" class="entry-title">
        <span class="tag" :class="typeClass(entry.type)">{{ typeLabel(entry.type) }}</span>
        <span v-if="label" class="cardLabel">{{ label }}</span>
      </h3>
      <div class="entry-card-indicators">
        <span class="entry-status">{{ statusLabel }}</span>
        <button class="favorite-toggle" type="button" aria-label="お気に入り" :aria-pressed="favorite" @click="tracker.toggleFavorite(entry)">{{ favorite ? '★' : '☆' }}</button>
      </div>
    </div>

    <div v-if="target && !lost" class="target-notice" :class="{ mine: target.mine }">
      <strong>{{ target.mine ? '自分が狙っています' : 'ほかの人が狙っています' }}</strong>
      <span>残り {{ formatDuration(target.expiresAt - tracker.now) }}</span>
    </div>
    <div class="coord">
      <strong>X {{ entry.x }} <span class="coord-divider">/</span> Y {{ entry.y }}</strong>
      <span v-if="dist !== null">自分から約 {{ dist.toFixed(1) }}</span>
      <span v-if="nearest" class="nearest-player"><strong>最寄り</strong> {{ nearestNames }}（約 {{ nearest.distance.toFixed(1) }}）</span>
    </div>

    <p v-if="lost" class="miniLabel">見失った状態を共有中。再発見したら解除するか、編集で時刻を更新してください。</p>
    <div v-else-if="!ready" class="entry-clock">
      <div>
        <div class="clockNote">{{ isAqua ? '次の浮上まで' : '自分の残り時間' }}</div>
        <div class="timeBig">{{ remainText }}</div>
      </div>
      <div class="entry-clock-at">{{ formatClock(attackableAt, isAqua) }} 頃</div>
    </div>

    <div v-if="ready && !isAqua" class="entry-outcome">
      <button v-if="!winnerHistoryId" type="button" class="btnSuccess" @click="onRecord">ルビーを獲得した</button>
      <div v-else class="entry-outcome-recorded">
        <span class="badge ok">獲得を記録済み</span>
        <button type="button" class="textAction" @click="onUndoRecord">獲得記録を取り消す</button>
      </div>
    </div>
    <form v-if="ready" class="entry-timer" @submit.prevent="onUpdate">
      <p class="entry-timer-title">{{ timerLabel }}</p>
      <p class="miniLabel">
        {{ isAqua ? `再浮上までの${entry.type === 'aqua' ? 72 : 32}時間は自動で加算します。` : winnerHistoryId ? 'ゲームに表示された獲得者本人の残り時間を入力。' : '取れなかったときは、ゲームに表示された残り時間を入力。' }}
      </p>
      <div class="readyInputs" :class="{ aqua: isAqua }">
        <div class="field"><label :for="`${cardId}-hours`">時間</label><input :id="`${cardId}-hours`" ref="hInput" v-model="rh" type="number" inputmode="numeric" min="0" :max="isAqua ? undefined : winnerHistoryId ? 120 : 24" placeholder="0"></div>
        <div class="field"><label :for="`${cardId}-minutes`">分</label><input :id="`${cardId}-minutes`" v-model="rm" type="number" inputmode="numeric" min="0" max="59" placeholder="0"></div>
        <div v-if="isAqua" class="field"><label :for="`${cardId}-seconds`">秒</label><input :id="`${cardId}-seconds`" v-model="rs" type="number" inputmode="numeric" min="0" max="59" placeholder="0"></div>
        <button class="btnReadyUpdate" :class="{ aqua: isAqua }" type="submit" :disabled="!hasTime">時間を保存</button>
      </div>
    </form>

    <div class="cardBtns">
      <button v-if="!lost && sync.isConfigured(channel) && (!target || target.mine)" type="button" class="btnTarget"
        :disabled="sync.targetBusy[channel]" :title="target?.mine ? undefined : '15分間、同期した相手に表示します'"
        @click="sync.toggleTarget(entry)">{{ target?.mine ? '狙う宣言を解除' : '狙う' }}</button>
      <button v-if="isAqua && (ready || lost) && sync.isConfigured('aqua')" type="button" :class="lost ? 'btnTarget' : 'btnLost'"
        :disabled="sync.aquaLostBusy || tracker.pendingTimerUpdate?.id === entry.id"
        @click="sync.toggleAquaLost(entry)">{{ lost ? '再発見した' : 'ロストにする' }}</button>
      <button type="button" class="btnEdit" @click="tracker.startEdit(entry.id)">編集</button>
      <button type="button" class="btnDelete" @click="tracker.deleteEntry(entry.id)">削除</button>
    </div>
  </article>
</template>
