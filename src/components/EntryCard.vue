<script setup>
import { ref, computed, nextTick } from 'vue'
import { useTrackerStore } from '@/stores/trackerStore'
import { typeLabel, typeClass, isAquaFamily, formatClock, formatDuration } from '@/utils/helpers'
import EntryEditForm from './EntryEditForm.vue'

const props = defineProps({
  entry: { type: Object, required: true },
  ready: { type: Boolean, default: false }
})

const tracker = useTrackerStore()
const isAqua = computed(() => isAquaFamily(props.entry.type))
const dist = computed(() => tracker.coordDistance(props.entry))
const remainText = computed(() => formatDuration(props.entry.eventAt - tracker.now))

const rh = ref('')
const rm = ref('')
const hInput = ref(null)

function onUpdate() {
  if (tracker.updateReady(props.entry.id, rh.value, rm.value)) {
    rh.value = ''
    rm.value = ''
  }
}

async function onRecord() {
  const ok = await tracker.recordAttackResult(props.entry.id)
  if (!ok) return
  await nextTick()
  if (hInput.value) {
    hInput.value.focus()
    hInput.value.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}
</script>

<template>
  <EntryEditForm v-if="tracker.inlineEditId === entry.id" :entry="entry" />

  <div v-else class="card" :class="{ ready: ready, aqua: ready && isAqua }">
    <div class="cardTop">
      <div>
        <span class="tag" :class="typeClass(entry.type)">{{ typeLabel(entry.type) }}</span>
        <span v-if="entry.label" class="cardLabel">{{ entry.label }}</span>
      </div>
    </div>
    <div class="coord">
      座標 X:{{ entry.x }} / Y:{{ entry.y }}<template v-if="dist !== null">　自分から約{{ dist.toFixed(1) }}</template>
    </div>

    <!-- 一覧タブ -->
    <template v-if="!ready">
      <div class="timeBig">{{ formatClock(entry.eventAt) }} 頃</div>
      <div class="clockNote">{{ isAqua ? '次の浮上まで ' : '残り ' }}{{ remainText }}</div>
    </template>

    <!-- 攻撃可能タブ -->
    <template v-else>
      <div class="timeBig readyText" :class="{ aqua: isAqua }">{{ isAqua ? '浮上中' : '攻撃可能' }}</div>
      <template v-if="!isAqua">
        <div v-if="entry.resultLogged" class="readyNote">この周期の結果は記録済みです。残り時間を入力して「更新」すると、次の周期でまた記録できます。</div>
        <div v-else class="resultBtns">
          <button class="btnSuccess" @click="onRecord">✓ 取れた！記録する</button>
        </div>
      </template>
      <div v-if="isAqua" class="readyNote aqua">
        {{ entry.type === 'aqua' ? '大アクア' : '小アクア' }}は獲得記録を行わず、時間管理のみ行います。「沈むまでの残り時間」を入力してください。再浮上までの時間（大アクア72時間・小アクア32時間）は自動で加算します。
      </div>
      <div v-else-if="!entry.resultLogged" class="readyNote">新規登録直後や攻撃後・狩られた後など、実際の画面に表示されている「再攻撃可能まで」の残り時間を入力してください。</div>
      <div class="readyInputs" :class="{ aqua: isAqua }">
        <div class="field"><label>時間</label><input ref="hInput" v-model="rh" type="number" min="0"></div>
        <div class="field"><label>分</label><input v-model="rm" type="number" min="0" max="59"></div>
        <button class="btnReadyUpdate" :class="{ aqua: isAqua }" @click="onUpdate">更新</button>
      </div>
    </template>

    <div class="cardBtns">
      <button class="btnEdit" @click="tracker.startEdit(entry.id)">編集</button>
      <button class="btnDelete" @click="tracker.deleteEntry(entry.id)">削除</button>
    </div>
  </div>
</template>