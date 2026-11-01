<script setup>
import { ref, watch, nextTick } from 'vue'
import { useTrackerStore } from '@/stores/trackerStore'
import { useUiStore } from '@/stores/uiStore'
import { TYPE_OPTIONS } from '@/utils/constants'
import { toNum } from '@/utils/helpers'

const props = defineProps({ open: Boolean })
const emit = defineEmits(['close'])
const tracker = useTrackerStore()
const ui = useUiStore()

const type = ref('wildFortress')
const bx = ref('')
const by = ref('')
const pasteText = ref('')
const list = ref([])
const xInput = ref(null)
const yInput = ref(null)

watch(() => props.open, async (v) => {
  if (!v) return
  list.value = []
  bx.value = ''
  by.value = ''
  pasteText.value = ''
  await nextTick()
  xInput.value && xInput.value.focus()
})

function removeItem(i) { list.value.splice(i, 1) }

function addOne() {
  const x = toNum(bx.value)
  const y = toNum(by.value)
  if (x === null || y === null) { ui.showAlert('座標を入力してください'); return }
  if (list.value.some((c) => c.x === x && c.y === y)) ui.showToast('すでにリストにあります')
  else list.value.push({ x, y })
  bx.value = ''
  by.value = ''
  xInput.value && xInput.value.focus()
}

function parsePaste() {
  const raw = pasteText.value.trim()
  if (!raw) { ui.showAlert('座標を入力してください'); return }
  const invalid = []
  let addedCount = 0
  raw.split(/\r?\n/).forEach((line, i) => {
    line = line.trim()
    if (!line) return
    const m = line.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,\/\s]\s*(-?\d+(?:\.\d+)?)\s*$/)
    if (!m) { invalid.push(i + 1); return }
    const c = { x: Number(m[1]), y: Number(m[2]) }
    if (list.value.some((b) => b.x === c.x && b.y === c.y)) return
    list.value.push(c)
    addedCount++
  })
  if (invalid.length) {
    ui.showAlert('読み取れない行があります: ' + invalid.join(', ') + '行目\n形式は「X,Y」または「X Y」です。それ以外の行はリストに追加しました。')
  } else {
    ui.showToast(addedCount + '件をリストに追加しました')
  }
  pasteText.value = ''
}

async function save() {
  const added = await tracker.submitBulk(type.value, list.value)
  if (added < 0) return
  list.value = []
  pasteText.value = ''
  emit('close')
}
</script>

<template>
  <div class="panel" :class="{ open }">
    <h2>複数登録</h2>
    <div class="field">
      <label>登録する種類</label>
      <select v-model="type">
        <option v-for="t in TYPE_OPTIONS" :key="t.value" :value="t.value">{{ t.label }}</option>
      </select>
    </div>

    <div class="rowFields">
      <div class="field">
        <label>X座標</label>
        <input ref="xInput" v-model="bx" type="number" min="0" placeholder="例: 662" @keydown.enter.prevent="yInput && yInput.focus()">
      </div>
      <div class="field">
        <label>Y座標</label>
        <input ref="yInput" v-model="by" type="number" min="0" placeholder="例: 662" @keydown.enter.prevent="addOne">
      </div>
    </div>
    <button class="addBtn secondary" type="button" style="margin-bottom:14px;" @click="addOne">＋ リストに追加</button>

    <div v-if="list.length" class="field">
      <label>登録予定({{ list.length }}件)</label>
      <div>
        <span v-for="(c, i) in list" :key="c.x + '|' + c.y" class="bulkChip">
          X:{{ c.x }} Y:{{ c.y }}
          <button type="button" @click="removeItem(i)">✕</button>
        </span>
      </div>
    </div>

    <details style="margin: 4px 0 14px;">
      <summary style="font-size:12px; color:#6b6a65; cursor:pointer;">まとめて貼り付けたい場合はこちら</summary>
      <div class="field" style="margin-top:10px;">
        <textarea v-model="pasteText" placeholder="1行に1件&#10;例: 662,662&#10;700,531&#10;または 662 662"></textarea>
        <button class="addBtn secondary" type="button" style="margin-top:8px;" @click="parsePaste">貼り付けた内容をリストに追加</button>
      </div>
    </details>

    <p class="bulkHint">追加した座標はすべて「攻撃可能」タブへ移動するので、そこから実際の残り時間を入力してください。</p>
    <div class="panelBtns">
      <button class="btnCancel" @click="emit('close')">キャンセル</button>
      <button class="btnSave" @click="save">登録する({{ list.length }}件)</button>
    </div>
  </div>
</template>