<script setup>
import { ref } from 'vue'
import { useTrackerStore } from '@/stores/trackerStore'
import { useSyncStore } from '@/stores/syncStore'
import { useUiStore } from '@/stores/uiStore'
import { CHANNEL_IDS, SYNC_CHANNELS } from '@/utils/constants'
import SyncLog from './SyncLog.vue'

const tracker = useTrackerStore()
const sync = useSyncStore()
const ui = useUiStore()

const userId = ref(tracker.userId)
const url = ref(sync.channels.fort.settings.url || sync.channels.aqua.settings.url || '')
const token = ref(sync.channels.fort.settings.token || sync.channels.aqua.settings.token || '')
const busy = ref(false)

async function save() {
  if (busy.value) return
  const uid = userId.value.trim()
  if ((url.value.trim() || token.value.trim()) && !/^[\x21-\x7E]{1,64}$/.test(uid)) {
    ui.showAlert('ユーザーIDを半角の英数字・記号で入力してください（日本語や空白は使えません）')
    return
  }
  busy.value = true
  try {
    await sync.saveConnection({ url: url.value, token: token.value, userId: uid })
  } finally {
    busy.value = false
  }
}

function stateOf(id) {
  if (!sync.isConfigured(id)) return ''
  if (sync.runtime[id].lastError) return 'error'
  return sync.channels[id].settings.lastSyncAt ? 'ok' : ''
}
</script>

<template>
  <div>
    <p class="miniLabel" style="margin-top:12px;">アクアも要塞・ドラゴンも、同じURL・合言葉で接続します。ユーザーIDは要塞・ドラゴンのデータの保存先を分けるための名前です（アクアは全員で共有）。</p>

    <div class="field">
      <label>ユーザーID（半角英数字・自分専用の名前）</label>
      <input v-model="userId" type="text" autocomplete="off" placeholder="例: takumi">
    </div>
    <div class="field">
      <label>サーバーのURL</label>
      <input v-model="url" type="text" autocomplete="off" placeholder="https://gge-tracker-api.xxxx.workers.dev">
    </div>
    <div class="field">
      <label>合言葉</label>
      <input v-model="token" type="password" autocomplete="off" placeholder="サーバーに登録した合言葉">
    </div>

    <div class="btnRow">
      <button class="btnPrimary" type="button" :disabled="busy" @click="save">{{ busy ? '接続中…' : '保存して接続' }}</button>
      <button class="btnGhost" type="button" :disabled="!sync.anyConfigured()" @click="sync.syncAll()">今すぐ同期</button>
    </div>
    <p class="miniLabel" style="margin-top:8px;">URLと合言葉を両方空欄にして保存すると、接続を解除します（この端末のデータは消えません）。</p>

    <ul class="statusList">
      <li v-for="id in CHANNEL_IDS" :key="id" :class="stateOf(id)">
        <span class="dot"></span>
        <span><b>{{ SYNC_CHANNELS[id].name }}</b>：{{ sync.statusText(id) }}</span>
      </li>
    </ul>

    <SyncLog />
  </div>
</template>
