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
const showToken = ref(false)
const standardUrl = 'https://gge-tracker-api.takutaku307.workers.dev'

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

async function disconnect() {
  if (busy.value || !(await ui.showConfirm('共有サーバーとの接続を解除しますか？ この端末の登録と履歴は残ります。'))) return
  await sync.saveConnection({ url: '', token: '', userId: userId.value })
  url.value = ''
  token.value = ''
  showToken.value = false
}

function stateOf(id) {
  if (!sync.isConfigured(id)) return ''
  if (sync.runtime[id].lastError) return 'error'
  return sync.channels[id].settings.lastSyncAt ? 'ok' : ''
}
</script>

<template>
  <div>
    <p class="miniLabel connection-intro">共有タイマーは画面を開いている間に5分ごとに同期します。要塞・ドラゴンの登録座標とルビー履歴は、同じユーザーIDの端末で確認できます。</p>

    <form @submit.prevent="save">
      <div class="field">
        <label for="connection-user">ユーザーID</label>
        <input id="connection-user" v-model="userId" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="64" placeholder="半角英数字・記号">
      </div>
      <div class="field">
        <label for="connection-url">サーバーのURL</label>
        <input id="connection-url" v-model="url" type="text" inputmode="url" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="https://…">
        <button v-if="url.trim() !== standardUrl" class="textAction" type="button" @click="url = standardUrl">標準サーバーのURLを入力</button>
      </div>
      <div class="field">
        <label for="connection-token">合言葉</label>
        <div class="connection-secret">
          <input id="connection-token" v-model="token" :type="showToken ? 'text' : 'password'" autocomplete="off" placeholder="共有サーバーの合言葉">
          <button class="textAction" type="button" :aria-pressed="showToken" @click="showToken = !showToken">{{ showToken ? '隠す' : '表示' }}</button>
        </div>
      </div>

      <div class="btnRow">
        <button class="btnPrimary" type="submit" :disabled="busy || !userId.trim() || !url.trim() || !token.trim()">{{ busy ? '接続中…' : '保存して接続' }}</button>
        <button v-if="sync.anyConfigured()" class="btnGhost" type="button" :disabled="busy || sync.summary().state === 'syncing'" @click="sync.syncAll()">今すぐ同期</button>
      </div>
    </form>

    <ul class="statusList">
      <li v-for="id in CHANNEL_IDS" :key="id" :class="stateOf(id)">
        <span class="dot"></span>
        <span><b>{{ SYNC_CHANNELS[id].name }}</b>：{{ sync.statusText(id) }}</span>
      </li>
    </ul>

    <SyncLog />
    <button v-if="sync.anyConfigured()" class="textAction connection-disconnect" type="button" :disabled="busy || sync.summary().state === 'syncing'" @click="disconnect">接続を解除</button>
  </div>
</template>
