<script setup>
import { ref, reactive, computed } from 'vue'
import { useTrackerStore } from '@/stores/trackerStore'
import { useSyncStore } from '@/stores/syncStore'
import { useUiStore } from '@/stores/uiStore'

const tracker = useTrackerStore()
const sync = useSyncStore()
const ui = useUiStore()

const aq = sync.channels.aqua.settings
const fs = sync.channels.fort.settings

const userIdDraft = ref(tracker.userId)
const aqua = reactive({ url: aq.url || '', token: aq.token || '' })
const fort = reactive({
  url: fs.url || '',
  token: fs.token || '',
  mode: fs.mode === 'snapshot' ? 'snapshot' : 'sync',
  leadMin: fs.leadMin,
  quietOn: !!fs.quietOn,
  quietStart: fs.quietStart,
  quietEnd: fs.quietEnd,
  digest: fs.digest !== false
})

const fortModeNote = computed(() =>
  fort.mode === 'snapshot'
    ? '通知のみ：この端末の一覧（通知対象のみ）をサーバーへ丸ごと送ります。他の端末へは反映されません。'
    : '端末同期：全端末が同じURL・合言葉・ユーザーIDで全件とルビー獲得記録を送受信します。'
)

/* 認証情報を入れて保存するときは、ユーザーIDも一緒に保存する */
function save(id, input) {
  const hasCreds = String(input.url || '').trim() || String(input.token || '').trim()
  if (hasCreds) {
    const uid = userIdDraft.value.trim()
    if (!/^[\x21-\x7E]+$/.test(uid)) {
      ui.showAlert('ユーザーIDを半角の英数字・記号で入力してください（日本語や空白は使えません）')
      return
    }
    tracker.setUserId(uid)
  }
  sync.saveChannelSettings(id, input)
}
</script>

<template>
  <div>
    <h3 style="font-size:14px;margin:18px 0 6px;">同期アカウント（アクア・要塞共通）</h3>
    <p class="miniLabel">サーバーとの通信では、合言葉を <b>Authorization: Bearer</b>、ユーザーIDを <b>X-User-Id</b> として送ります。同じデータを別の端末と共有するには、同じユーザーID・URL・合言葉を入力してください。</p>
    <div class="field">
      <label>ユーザーID（半角英数字）</label>
      <input v-model="userIdDraft" type="text" autocomplete="off" placeholder="例: myname01">
    </div>

    <!-- ① アクア -->
    <h3 style="font-size:14px;margin:18px 0 6px;">アクア同期（Cloudflare）</h3>
    <p class="miniLabel">大アクア・小アクアの座標と時刻だけを相手と共有します。ドラゴン・要塞・自分の座標・ルビー履歴は送信されず、この端末にだけ保存されます。日付が変わって最初に開いた時に自動で同期し、上の「今すぐ同期」でも手動同期できます。</p>
    <div class="field"><label>同期URL（Workers）</label><input v-model="aqua.url" type="text" autocomplete="off" placeholder="https://xxxx.workers.dev"></div>
    <div class="field"><label>合言葉</label><input v-model="aqua.token" type="password" autocomplete="off" placeholder="サーバー側と同じ合言葉"></div>
    <button class="addBtn secondary" type="button" @click="save('aqua', aqua)">同期設定を保存して今すぐ同期</button>
    <p class="miniLabel" style="margin-top:2px;">{{ sync.statusText('aqua') }}</p>
    <p class="miniLabel">URLと合言葉を両方空欄にして保存すると、同期を解除します（この端末のデータは消えません）。</p>

    <!-- ② 要塞・ドラゴン -->
    <h3 style="font-size:14px;margin:18px 0 6px;">要塞・ドラゴン同期＋Discord通知</h3>
    <p class="miniLabel">ドラゴン・砂漠の要塞・野生の要塞の「種類・座標・時刻・メモ」を共有します。自分の座標・距離設定は送信されません。ルビー獲得記録は「端末同期」のときだけ共有します（「通知のみ」では送信されません）。「端末同期」では、別の端末でも同じURL・合言葉・ユーザーIDを入れると確認・編集・削除が反映されます。「通知のみ」はこの端末の一覧をサーバーへ送ってDiscord通知に使うだけです。どちらもこのページを開いている間は<b>5分おき</b>に自動で実行します。</p>
    <div class="field">
      <label>方式</label>
      <select v-model="fort.mode">
        <option value="sync">端末同期（全端末で確認・編集・削除を共有）</option>
        <option value="snapshot">通知のみ（この端末の一覧をサーバーへ送るだけ）</option>
      </select>
    </div>
    <p class="miniLabel" style="margin-top:2px;">{{ fortModeNote }}</p>
    <div class="field"><label>同期URL（Workers）</label><input v-model="fort.url" type="text" autocomplete="off" placeholder="https://xxxx.workers.dev"></div>
    <div class="field"><label>合言葉</label><input v-model="fort.token" type="password" autocomplete="off" placeholder="サーバー側と同じ合言葉"></div>

    <p class="miniLabel" style="margin:10px 0 4px;">Discord通知の設定（時刻は日本時間。最後に同期した端末の設定が使われます）</p>
    <div class="rowFields">
      <div class="field"><label>何分前に通知</label><input v-model="fort.leadMin" type="number" min="0" max="60" step="1" placeholder="10"></div>
    </div>
    <label style="display:flex;gap:8px;align-items:center;margin:6px 0;font-size:13px;"><input v-model="fort.quietOn" type="checkbox">通知を止める時間帯を使う</label>
    <div class="rowFields">
      <div class="field"><label>停止の開始（時）</label><input v-model="fort.quietStart" type="number" min="0" max="23" step="1" placeholder="0"></div>
      <div class="field"><label>停止の終了（時）</label><input v-model="fort.quietEnd" type="number" min="0" max="23" step="1" placeholder="7"></div>
    </div>
    <label style="display:flex;gap:8px;align-items:center;margin:6px 0 10px;font-size:13px;"><input v-model="fort.digest" type="checkbox">停止が明けたら、停止中に攻撃可能になった分をまとめて通知</label>

    <button class="addBtn secondary" type="button" @click="save('fort', fort)">同期設定を保存して今すぐ同期</button>
    <button class="addBtn secondary" type="button" @click="sync.testNotify()">Discord通知テスト</button>
    <p class="miniLabel" style="margin-top:2px;">{{ sync.statusText('fort') }}</p>
    <p class="miniLabel">URLと合言葉を両方空欄にして保存すると、同期を解除します（この端末のデータは消えません）。通知の対象は、この端末の「表示」と「距離フィルター」の設定に合うものだけです（端末ごとに設定が違うと、最後に同期した端末の設定になります）。</p>
  </div>
</template>