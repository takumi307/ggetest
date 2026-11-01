<script setup>
import { computed, ref } from 'vue'
import { useTrackerStore } from '@/stores/trackerStore'
import { useSyncStore } from '@/stores/syncStore'
import { useUiStore } from '@/stores/uiStore'
import { PRESET_COORDS } from '@/data/presetCoords'
import { DISTANCE_TYPE_LIST } from '@/utils/constants'
import { newId } from '@/utils/helpers'

const tracker = useTrackerStore()
const sync = useSyncStore()
const ui = useUiStore()

/* 標準座標のうち、数値として正しいものだけを使う */
function validList(type) {
  const raw = (PRESET_COORDS && PRESET_COORDS[type]) || []
  return raw
    .map((c) => [Number(c[0]), Number(c[1])])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
}

const rows = computed(() =>
  DISTANCE_TYPE_LIST.map(([type, name]) => {
    const list = validList(type)
    const missing = list.filter(([x, y]) => !tracker.findCoordDuplicate(type, x, y)).length
    return { type, name, total: list.length, missing }
  })
)
const totalAll = computed(() => rows.value.reduce((s, r) => s + r.total, 0))
const totalMissing = computed(() => rows.value.reduce((s, r) => s + r.missing, 0))

async function load() {
  if (!totalAll.value) {
    ui.showAlert('標準座標がまだ設定されていません。下の「現在の座標を書き出す」で作った内容を、src/data/presetCoords.js に貼り付けてください。')
    return
  }
  if (!totalMissing.value) { ui.showToast('追加する座標はありません（すべて登録済みです）'); return }
  const ok = await ui.showConfirm(
    `標準座標から ${totalMissing.value} 件を追加します（登録済みの座標は追加しません）。\n追加した座標は「攻撃可能」タブに入るので、残り時間を入力してください。`
  )
  if (!ok) return
  const base = Date.now()
  let added = 0
  DISTANCE_TYPE_LIST.forEach(([type]) => {
    validList(type).forEach(([x, y]) => {
      if (tracker.findCoordDuplicate(type, x, y)) return
      const entry = { id: newId(7), type, label: '', x, y, eventAt: base }
      sync.touchSync(entry)
      tracker.entries.push(entry)
      added++
    })
  })
  ui.showToast(`${added}件を追加しました → 攻撃可能タブで残り時間を入力できます`)
}

/* 現在の登録から、標準座標ファイルの内容を作る */
const exportText = ref('')
const exportArea = ref(null)

function makeExport() {
  const lines = [
    '// 標準座標（ドラゴン・砂漠の要塞・野生の要塞）',
    '// 「設定」→「標準座標」→「現在の座標を書き出す」で作った内容です。',
    'export const PRESET_COORDS = {'
  ]
  DISTANCE_TYPE_LIST.forEach(([type], i) => {
    const seen = new Set()
    const list = tracker.entries
      .filter((e) => e.type === type && Number.isFinite(Number(e.x)) && Number.isFinite(Number(e.y)))
      .map((e) => [Number(e.x), Number(e.y)])
      .filter(([x, y]) => {
        const k = x + '|' + y
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    lines.push(`  ${type}: [`)
    list.forEach(([x, y]) => lines.push(`    [${x}, ${y}],`))
    lines.push(i < DISTANCE_TYPE_LIST.length - 1 ? '  ],' : '  ]')
  })
  lines.push('}', '')
  exportText.value = lines.join('\n')
}

async function copy() {
  try {
    await navigator.clipboard.writeText(exportText.value)
  } catch (e) {
    if (exportArea.value) { exportArea.value.select(); document.execCommand('copy') }
  }
  ui.showToast('コピーしました')
}
</script>

<template>
  <div>
    <p class="miniLabel" style="margin-top:12px;">座標が変わらない種類（ドラゴン・砂漠の要塞・野生の要塞）を、ボタン1つでまとめて登録します。端末を買い替えたときや、もう1人の初期設定に使えます。</p>

    <ul class="statusList">
      <li v-for="r in rows" :key="r.type" :class="r.total && !r.missing ? 'ok' : ''">
        <span class="dot"></span>
        <span><b>{{ r.name }}</b>：標準 {{ r.total }}件／未登録 {{ r.missing }}件</span>
      </li>
    </ul>
    <p v-if="!totalAll" class="notice warn">標準座標がまだ設定されていません。下の「現在の座標を書き出す」で内容を作り、GitHubの <b>src/data/presetCoords.js</b> に貼り付けてください。</p>

    <div class="btnRow">
      <button class="btnPrimary" type="button" :disabled="!totalMissing" @click="load">標準座標を読み込む（{{ totalMissing }}件）</button>
    </div>

    <div class="subHead">標準座標を作る・更新する</div>
    <p class="miniLabel" style="margin:0 0 6px;">座標が入っている端末で押すと、いま登録されているドラゴン・要塞の座標から、ファイルの内容を作ります。コピーして <b>src/data/presetCoords.js</b> に貼り付けると、全端末で使えます。</p>
    <div class="btnRow" style="margin-top:0;">
      <button class="btnGhost" type="button" @click="makeExport">現在の座標を書き出す</button>
    </div>
    <template v-if="exportText">
      <div class="field" style="margin-top:10px;">
        <textarea ref="exportArea" :value="exportText" readonly style="height:160px;"></textarea>
      </div>
      <div class="btnRow" style="margin-top:0;">
        <button class="btnPrimary" type="button" @click="copy">コピーする</button>
      </div>
    </template>
    <p class="miniLabel" style="margin-top:10px;">標準座標はアプリのファイルに含まれるため、公開URLを知っている人は座標を見られます。ゲームの地図上の座標なので問題ないと思いますが、気になる場合は共有範囲に注意してください。</p>
  </div>
</template>
