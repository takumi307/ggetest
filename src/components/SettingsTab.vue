<script setup>
import { computed } from 'vue'
import { useTrackerStore } from '@/stores/trackerStore'
import { useSyncStore } from '@/stores/syncStore'
import SettingCard from './SettingCard.vue'
import ConnectionSettings from './ConnectionSettings.vue'
import NotifySettings from './NotifySettings.vue'
import DisplaySettings from './DisplaySettings.vue'
import PresetCoords from './PresetCoords.vue'

const tracker = useTrackerStore()
const sync = useSyncStore()

const connBadge = computed(() => {
  const s = sync.summary()
  return { text: s.text, type: s.state === 'ok' ? 'ok' : s.state === 'error' ? 'error' : 'warn' }
})
function notifyBadge(id) {
  if (!sync.isConfigured(id)) return { text: '未接続', type: 'warn' }
  return sync.notify[id].webhookSet ? { text: '通知ON', type: 'ok' } : { text: 'Webhook未登録', type: 'warn' }
}
const fortBadge = computed(() => notifyBadge('fort'))
const aquaBadge = computed(() => notifyBadge('aqua'))
</script>

<template>
  <div>
    <SettingCard title="接続" icon="🔗" :badge="connBadge.text" :badge-type="connBadge.type" :open="!sync.anyConfigured()">
      <ConnectionSettings />
    </SettingCard>

    <SettingCard title="通知：要塞・ドラゴン（あなた専用）" icon="🔔" :badge="fortBadge.text" :badge-type="fortBadge.type">
      <NotifySettings channel="fort" />
    </SettingCard>

    <SettingCard title="通知：アクア（全員で共有）" icon="🌊" :badge="aquaBadge.text" :badge-type="aquaBadge.type">
      <NotifySettings channel="aqua" />
    </SettingCard>

    <SettingCard title="標準座標（固定の座標）" icon="📍">
      <PresetCoords />
    </SettingCard>

    <SettingCard title="表示・距離の設定" icon="👁️">
      <DisplaySettings />
    </SettingCard>

    <SettingCard title="データ管理" icon="🧹">
      <p class="miniLabel" style="margin-top:12px;">小アクア・大アクアの座標登録をまとめて削除します。攻撃履歴・ルビー集計は残ります。アクアは全員で共有しているため、削除は次回の同期で相手の端末からも消えます。</p>
      <div class="btnRow">
        <button class="btnDanger" type="button" @click="tracker.clearAquaCoordinates()">小アクア・大アクアの座標を全削除</button>
      </div>
    </SettingCard>
  </div>
</template>
