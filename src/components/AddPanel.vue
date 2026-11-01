<script setup>
import { reactive, computed, watch } from 'vue'
import { useTrackerStore } from '@/stores/trackerStore'
import { TYPE_OPTIONS } from '@/utils/constants'
import { isAquaFamily } from '@/utils/helpers'

const props = defineProps({ open: Boolean })
const emit = defineEmits(['close'])
const tracker = useTrackerStore()

const form = reactive({ type: 'dragon', label: '', x: '', y: '', rh: '', rm: '' })

watch(() => props.open, (v) => {
  if (v) Object.assign(form, { type: 'dragon', label: '', x: '', y: '', rh: '', rm: '' })
})

const remainLabel = computed(() => (isAquaFamily(form.type) ? '沈むまでの残り時間' : '現在の残り時間'))
const remainHint = computed(() => {
  if (isAquaFamily(form.type)) {
    const h = form.type === 'aqua' ? 72 : 32
    return `沈んだあと${h}時間後に再浮上すると仮定して自動計算します（${h}時間は自動で加算されるので、画面に表示されている「沈むまで」の時間をそのまま入力）。空欄のまま保存すると「攻撃可能」タブに入り、あとから入力できます。`
  }
  return '画面に表示されている「攻撃可能になるまで」の時間を入力(例: 78時間ならそのまま78)。空欄のまま保存すると「攻撃可能」タブに入り、あとから残り時間を入力できます。'
})

async function save() {
  if (await tracker.submitNew(form)) emit('close')
}
</script>

<template>
  <div class="panel" :class="{ open }">
    <h2>新規登録</h2>
    <div class="rowFields">
      <div class="field">
        <label>種類</label>
        <select v-model="form.type">
          <option v-for="t in TYPE_OPTIONS" :key="t.value" :value="t.value">{{ t.label }}</option>
        </select>
      </div>
      <div class="field">
        <label>ラベル(任意)</label>
        <input v-model="form.label" type="text" placeholder="例: 0126">
      </div>
    </div>
    <div class="rowFields">
      <div class="field"><label>X座標</label><input v-model="form.x" type="number" min="0" placeholder="例: 662"></div>
      <div class="field"><label>Y座標</label><input v-model="form.y" type="number" min="0" placeholder="例: 662"></div>
    </div>
    <div class="field">
      <label>{{ remainLabel }}</label>
      <div class="rowFields">
        <div class="field"><input v-model="form.rh" type="number" min="0" placeholder="時間"></div>
        <div class="field"><input v-model="form.rm" type="number" min="0" max="59" placeholder="分"></div>
      </div>
      <p class="miniLabel">{{ remainHint }}</p>
    </div>
    <div class="panelBtns">
      <button class="btnCancel" @click="emit('close')">キャンセル</button>
      <button class="btnSave" @click="save">保存</button>
    </div>
  </div>
</template>