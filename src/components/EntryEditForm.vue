<script setup>
import { reactive } from 'vue'
import { useTrackerStore } from '@/stores/trackerStore'
import { TYPE_OPTIONS } from '@/utils/constants'
import { isAquaFamily } from '@/utils/helpers'

const props = defineProps({ entry: { type: Object, required: true } })
const tracker = useTrackerStore()

const form = reactive({
  type: props.entry.type,
  label: props.entry.label || '',
  x: props.entry.x,
  y: props.entry.y,
  rh: '',
  rm: ''
})

function remainLabel() {
  return isAquaFamily(props.entry.type) ? '沈むまでの残り時間(空欄なら変更なし)' : '残り時間(空欄なら変更なし)'
}
function save() { tracker.submitEdit(props.entry.id, form) }
</script>

<template>
  <div class="card" style="border-color:#2c2c2a;">
    <h2 style="font-size:14px; margin:0 0 12px;">編集</h2>
    <div class="rowFields">
      <div class="field">
        <label>種類</label>
        <select v-model="form.type">
          <option v-for="t in TYPE_OPTIONS" :key="t.value" :value="t.value">{{ t.label }}</option>
        </select>
      </div>
      <div class="field"><label>ラベル</label><input v-model="form.label" type="text"></div>
    </div>
    <div class="rowFields">
      <div class="field"><label>X座標</label><input v-model="form.x" type="number"></div>
      <div class="field"><label>Y座標</label><input v-model="form.y" type="number"></div>
    </div>
    <div class="field">
      <label>{{ remainLabel() }}</label>
      <div class="rowFields">
        <div class="field"><input v-model="form.rh" type="number" min="0" placeholder="時間"></div>
        <div class="field"><input v-model="form.rm" type="number" min="0" max="59" placeholder="分"></div>
      </div>
    </div>
    <div class="panelBtns">
      <button class="btnCancel" @click="tracker.cancelEdit()">キャンセル</button>
      <button class="btnSave" @click="save">保存</button>
    </div>
  </div>
</template>