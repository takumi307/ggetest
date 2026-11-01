<script setup>
import { ref, watch } from 'vue'
import { useTrackerStore } from '@/stores/trackerStore'
import { useUiStore } from '@/stores/uiStore'

const props = defineProps({ open: Boolean })
const emit = defineEmits(['close'])
const tracker = useTrackerStore()
const ui = useUiStore()

const exportText = ref('')
const importText = ref('')
const exportArea = ref(null)
const fileInput = ref(null)

watch(() => props.open, (v) => {
  if (!v) return
  exportText.value = tracker.exportJson()
  importText.value = ''
})

async function copy() {
  try {
    await navigator.clipboard.writeText(exportText.value)
  } catch (e) {
    if (exportArea.value) { exportArea.value.select(); document.execCommand('copy') }
  }
  ui.showAlert('コピーしました。新しい場所に貼り付けてください。')
}

function download() {
  const blob = new Blob([tracker.exportJson()], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const fname = tracker.backupFileName()
  const a = document.createElement('a')
  a.href = url
  a.download = fname
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 2000)
  ui.showToast('ファイルを保存しました(' + fname + ')')
}

function onFile(ev) {
  const file = ev.target.files && ev.target.files[0]
  ev.target.value = ''
  if (!file) return
  const reader = new FileReader()
  reader.onload = (e) => { if (tracker.importRaw(e.target.result)) emit('close') }
  reader.onerror = () => ui.showAlert('ファイルを読み込めませんでした。')
  reader.readAsText(file)
}

function importPasted() {
  if (tracker.importRaw(importText.value)) emit('close')
}
</script>

<template>
  <div class="panel" :class="{ open }">
    <h2>データの引き継ぎ</h2>
    <p class="miniLabel">座標が多いとコピー&貼り付けは大変なので、ファイルとして保存/読み込みするのがおすすめです。</p>

    <div class="panelBtns" style="margin-bottom:16px;">
      <button class="btnSave" type="button" @click="download">① ファイルに保存する</button>
    </div>
    <button class="addBtn secondary" type="button" style="margin-bottom:16px;" @click="fileInput && fileInput.click()">② ファイルを選んで読み込む</button>
    <input ref="fileInput" type="file" accept="application/json,.json" style="display:none;" @change="onFile">

    <details style="margin: 4px 0 4px;">
      <summary style="font-size:12px; color:#6b6a65; cursor:pointer;">コピー&貼り付けで移行したい場合はこちら</summary>
      <div class="field" style="margin-top:10px;">
        <label>①今のデータ(コピーしてください)</label>
        <textarea ref="exportArea" :value="exportText" readonly></textarea>
      </div>
      <div class="panelBtns" style="margin-bottom:16px;">
        <button class="btnSave" type="button" @click="copy">コピーする</button>
      </div>
      <div class="field">
        <label>②別の場所のデータを貼り付けて読み込む</label>
        <textarea v-model="importText" placeholder="ここに貼り付け"></textarea>
      </div>
      <div class="panelBtns" style="margin-bottom:14px;">
        <button class="btnSave" type="button" @click="importPasted">貼り付けた内容を読み込む</button>
      </div>
    </details>

    <div class="panelBtns">
      <button class="btnCancel" style="flex:1;" @click="emit('close')">閉じる</button>
    </div>
  </div>
</template>