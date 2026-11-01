<script setup>
import { reactive, ref, computed, watch } from 'vue'
import { useSyncStore } from '@/stores/syncStore'
import { useUiStore } from '@/stores/uiStore'
import { NOTIFY_TYPE_LIST, LEAD_OPTIONS } from '@/utils/constants'
import ToggleSwitch from './ToggleSwitch.vue'

const props = defineProps({ channel: { type: String, required: true } })
const sync = useSyncStore()
const ui = useUiStore()

const n = computed(() => sync.notify[props.channel])
const configured = computed(() => sync.isConfigured(props.channel))
const isAqua = computed(() => props.channel === 'aqua')
const typeList = computed(() => NOTIFY_TYPE_LIST[props.channel])
const hours = Array.from({ length: 24 }, (_, i) => i)

const draft = reactive({ leadMin: 10, quietOn: false, quietStart: 0, quietEnd: 7, digest: true, roleId: '', types: {} })
const webhook = ref('')
const busy = ref(false)

function loadDraft() {
  const s = n.value.settings
  Object.assign(draft, {
    leadMin: s.leadMin, quietOn: s.quietOn, quietStart: s.quietStart, quietEnd: s.quietEnd,
    digest: s.digest, roleId: s.roleId
  })
  draft.types = Object.assign({}, s.types)
}
watch(() => n.value.settings, loadDraft, { deep: true, immediate: true })

const leadOptions = computed(() => {
  const list = LEAD_OPTIONS.slice()
  if (!list.includes(Number(draft.leadMin))) list.push(Number(draft.leadMin))
  return list.sort((a, b) => a - b)
})

function snapshot(o) {
  return JSON.stringify([
    Number(o.leadMin), !!o.quietOn, Number(o.quietStart), Number(o.quietEnd), !!o.digest,
    String(o.roleId || '').trim(), typeList.value.map(([t]) => !!(o.types && o.types[t]))
  ])
}
const dirty = computed(() => webhook.value.trim() !== '' || snapshot(draft) !== snapshot(n.value.settings))

async function save() {
  if (busy.value) return
  busy.value = true
  try {
    const settings = {
      leadMin: Number(draft.leadMin), quietOn: draft.quietOn, quietStart: Number(draft.quietStart),
      quietEnd: Number(draft.quietEnd), digest: draft.digest, roleId: String(draft.roleId || '').trim(),
      types: Object.assign({}, draft.types)
    }
    const hook = webhook.value.trim()
    if (await sync.saveNotify(props.channel, settings, hook === '' ? undefined : hook)) webhook.value = ''
  } finally {
    busy.value = false
  }
}

async function test() {
  const hook = webhook.value.trim()
  if (!hook && !n.value.webhookSet) { ui.showAlert('先にWebhook URLを入力してください'); return }
  busy.value = true
  try { await sync.testNotify(props.channel, hook) } finally { busy.value = false }
}

async function removeWebhook() {
  if (!(await ui.showConfirm('登録済みのWebhook URLを解除しますか？\n解除すると、Discordへの通知は届かなくなります。'))) return
  await sync.saveNotify(props.channel, undefined, '')
}
</script>

<template>
  <div>
    <p class="notice" style="margin-top:12px;">
      <template v-if="isAqua">アクアの座標と通知設定は、同じ接続先を使う<b>全員で共有</b>されます。ここで変更すると、相手にも反映されます。通知は、ここで登録した共通のDiscordチャンネルに届きます。</template>
      <template v-else>要塞・ドラゴンの通知は、あなたのユーザーIDのデータだけが対象です。ここで登録した<b>あなた専用</b>のDiscordチャンネルに届きます。</template>
    </p>

    <p v-if="!configured" class="notice warn">先に「接続」カードでURL・合言葉・ユーザーIDを保存してください。</p>
    <p v-else-if="n.error" class="notice warn">
      通知設定を読み込めませんでした：{{ n.error }}
      <span class="btnRow"><button class="btnGhost" type="button" @click="sync.loadNotify(channel)">再読み込み</button></span>
    </p>

    <template v-if="configured">
      <div class="subHead">Discord Webhook URL</div>
      <p v-if="n.webhookSet" class="miniLabel" style="margin:0 0 6px;">✅ 登録済み（{{ n.webhookHint }}）。変更するときだけ、下に新しいURLを入力してください。</p>
      <p v-else class="miniLabel" style="margin:0 0 6px;">未登録です。通知を受け取るチャンネルのWebhook URLを入力してください。</p>
      <div class="field">
        <input v-model="webhook" type="text" autocomplete="off" placeholder="https://discord.com/api/webhooks/…">
      </div>
      <details>
        <summary style="font-size:12px; color:#6b6a65; cursor:pointer;">Webhook URLの作り方</summary>
        <p class="miniLabel" style="margin-top:6px;">Discordで通知を受け取りたいチャンネルの「チャンネルの編集」→「連携サービス」→「ウェブフック」→「新しいウェブフック」を開き、「ウェブフックURLをコピー」を押して、上に貼り付けます。</p>
      </details>

      <div class="subHead">通知する種類</div>
      <ToggleSwitch
        v-for="[t, name] in typeList"
        :key="t"
        v-model="draft.types[t]"
        :label="name"
        :hint="draft.types[t] ? 'Discordに通知します' : '通知しません（一覧には表示されます）'"
      />

      <div class="subHead">通知のタイミング</div>
      <div class="field">
        <label>何分前に通知するか</label>
        <select v-model.number="draft.leadMin">
          <option v-for="m in leadOptions" :key="m" :value="m">{{ m === 0 ? '時刻ちょうど' : m + '分前' }}</option>
        </select>
      </div>

      <ToggleSwitch v-model="draft.quietOn" label="通知を止める時間帯を使う" hint="寝ている間などに通知を送りません（日本時間）" />
      <div v-if="draft.quietOn" class="selectRow" style="margin:10px 0;">
        <select v-model.number="draft.quietStart">
          <option v-for="h in hours" :key="'s' + h" :value="h">{{ h }}時</option>
        </select>
        <span>から</span>
        <select v-model.number="draft.quietEnd">
          <option v-for="h in hours" :key="'e' + h" :value="h">{{ h }}時</option>
        </select>
        <span>まで</span>
      </div>
      <ToggleSwitch v-model="draft.digest" label="停止が明けたらまとめて通知" hint="停止中に時刻を迎えた分を、明けてから1回にまとめて送ります" />

      <details style="margin-top:12px;">
        <summary style="font-size:12px; color:#6b6a65; cursor:pointer;">ロールにメンションする（任意）</summary>
        <div class="field" style="margin-top:8px;">
          <label>ロールID（数字）</label>
          <input v-model="draft.roleId" type="text" inputmode="numeric" autocomplete="off" placeholder="空欄ならメンションしません">
        </div>
      </details>

      <div class="btnRow">
        <button class="btnPrimary" type="button" :disabled="busy" @click="save">保存</button>
        <button class="btnGhost" type="button" :disabled="busy" @click="test">テスト送信</button>
      </div>
      <p v-if="dirty" class="dirtyNote">● 未保存の変更があります</p>
      <div v-if="n.webhookSet" class="btnRow">
        <button class="btnDanger" type="button" :disabled="busy" @click="removeWebhook">Webhook URLを解除</button>
      </div>
    </template>
  </div>
</template>
