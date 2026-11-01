<script setup>
import { computed } from 'vue'
import { useSyncStore } from '@/stores/syncStore'
import { CHANNEL_IDS, SYNC_CHANNELS } from '@/utils/constants'
import { typeLabel, formatClock } from '@/utils/helpers'

const sync = useSyncStore()

const KIND_LABEL = { add: '＋追加', update: '✎更新', delete: '✕削除' }

const rows = computed(() =>
  sync.syncLog.slice().reverse().map((l) => {
    const def = SYNC_CHANNELS[l.ch] || SYNC_CHANNELS.aqua
    const cs = l.changes || []
    const n = { add: 0, update: 0, delete: 0 }
    cs.forEach((c) => { n[c.kind]++ })
    const summary = cs.length
      ? `相手の更新 ${cs.length}件（追加${n.add}・更新${n.update}・削除${n.delete}）`
      : (l.mode === 'snapshot' ? '通知用の一覧を送信（一方向）' : '相手の更新なし')
    const sent = `送信 ${l.sent || 0}件` + (l.ruby && (l.ruby.add || l.ruby.del) ? `／ルビー記録 +${l.ruby.add} -${l.ruby.del}` : '')
    const details = cs.map((c) => {
      const t = `${typeLabel(c.type)} (${c.x},${c.y})`
      let tm = ''
      if (c.kind === 'add') tm = ' → 次の時刻 ' + formatClock(c.to)
      if (c.kind === 'update') tm = ' → 次の時刻 ' + formatClock(c.to) + '（旧 ' + formatClock(c.from) + '）'
      return `${KIND_LABEL[c.kind]} ${t}${tm}`
    })
    return { key: l.at + '-' + l.ch, time: formatClock(l.at), name: def.name, auto: l.auto, summary, sent, details }
  })
)
</script>

<template>
  <div>
    <template v-for="id in CHANNEL_IDS" :key="id">
      <button
        v-if="sync.isConfigured(id)"
        class="addBtn secondary"
        type="button"
        style="margin-bottom:14px;"
        :disabled="sync.runtime[id].syncing"
        @click="sync.syncNow(id, false)"
      >{{ sync.runtime[id].syncing ? '🔄 同期中…' : sync.btnLabel(id) }}</button>
    </template>

    <details v-if="sync.anyConfigured()" style="margin:-6px 0 14px; background:#fff; border:1px solid #e0dccf; border-radius:10px; padding:8px 12px;">
      <summary style="cursor:pointer; font-weight:700; font-size:13px;">📜 同期の反映履歴</summary>
      <div style="margin-top:8px; font-size:12px; line-height:1.6;">
        <p v-if="!rows.length" class="miniLabel" style="margin:0;">まだ同期履歴はありません。</p>
        <div v-for="r in rows" :key="r.key" style="padding:6px 0; border-bottom:1px solid #eee;">
          <b>{{ r.time }}</b> [{{ r.name }}]（{{ r.auto ? '自動' : '手動' }}）　{{ r.summary }}
          <span style="color:#888;">　{{ r.sent }}</span>
          <div v-for="(d, i) in r.details" :key="i" style="padding-left:12px;">{{ d }}</div>
        </div>
      </div>
      <button class="addBtn secondary" type="button" style="margin-top:8px; padding:6px 10px; font-size:12px;" @click="sync.clearSyncLog()">履歴を消去</button>
    </details>
  </div>
</template>