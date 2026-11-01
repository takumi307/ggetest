<script setup>
import { reactive, watch } from 'vue'
import { useTrackerStore } from '@/stores/trackerStore'
import { DISPLAY_TYPE_LIST, DISTANCE_TYPES, HOME_COORD_FIELDS } from '@/utils/constants'
import SyncSettings from './SyncSettings.vue'

const tracker = useTrackerStore()

/* 編集用の下書き。「設定を保存」を押したときだけ本体へ反映する（元の動作と同じ） */
const draft = reactive({ enabled: {}, near50: {}, nearDistance: {}, home: {} })
function loadDraft() {
  const s = tracker.settings
  draft.enabled = Object.assign({}, s.enabled)
  draft.near50 = Object.assign({}, s.near50)
  const nd = {}
  DISTANCE_TYPES.forEach((t) => {
    const v = Number(s.nearDistance && s.nearDistance[t])
    nd[t] = !Number.isFinite(v) || v < 0 ? 50 : v
  })
  draft.nearDistance = nd
  const home = {}
  DISTANCE_TYPES.forEach((t) => {
    const h = (s.homeCoords && s.homeCoords[t]) || {}
    home[t] = { x: h.x == null ? '' : h.x, y: h.y == null ? '' : h.y }
  })
  draft.home = home
}
loadDraft()
watch(() => tracker.settings, loadDraft, { deep: true }) // 引き継ぎ読み込みなどで設定が変わったら下書きも更新

function isDistanceType(t) { return DISTANCE_TYPES.includes(t) }
function save() { tracker.saveSettings(draft) }
</script>

<template>
  <details class="panel" style="display:block;margin-bottom:14px;">
    <summary style="font-weight:700;cursor:pointer;">表示・記録設定（種類ごとにオン／オフ）</summary>
    <p class="miniLabel">オフにしても登録データは削除されず、一覧・攻撃可能タブで非表示になります。</p>

    <div>
      <div v-for="[t, name] in DISPLAY_TYPE_LIST" :key="t" style="padding:7px 0;border-bottom:1px solid #e5e5e5;">
        <label style="display:flex;gap:8px;align-items:center;margin:4px 0;color:#2c2c2a;">
          <input v-model="draft.enabled[t]" type="checkbox">{{ name }}を表示
        </label>
        <div v-if="isDistanceType(t)" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:4px 0 4px 24px;color:#555;font-size:13px;">
          <label style="display:flex;gap:6px;align-items:center;">
            <input v-model="draft.near50[t]" type="checkbox">距離上限以内のみ表示
          </label>
          <input v-model="draft.nearDistance[t]" type="number" min="0" step="1" style="width:76px;padding:5px;border:1px solid #ccc;border-radius:6px;height:auto;">
          <span>以内</span>
        </div>
      </div>
    </div>

    <p class="miniLabel" style="margin:12px 0 6px;">距離フィルター：種類ごとに表示する距離の上限を自由に設定できます。件数は設定欄に表示します。</p>
    <div style="font-size:13px;line-height:1.8;margin-bottom:10px;">
      <div v-for="c in tracker.nearCounts" :key="c.type">
        {{ c.name }}：距離{{ c.limit }}以内 {{ c.count }}件<template v-if="!c.hasHome">（自分の座標を設定してください）</template>
      </div>
    </div>

    <template v-for="f in HOME_COORD_FIELDS" :key="f.type">
      <h3 style="font-size:14px;margin:14px 0 6px;">{{ f.title }}</h3>
      <div class="rowFields">
        <div class="field"><label>X座標</label><input v-model="draft.home[f.type].x" type="number" placeholder="X座標"></div>
        <div class="field"><label>Y座標</label><input v-model="draft.home[f.type].y" type="number" placeholder="Y座標"></div>
      </div>
    </template>
    <button class="addBtn secondary" type="button" @click="save">設定を保存</button>

    <SyncSettings />

    <h3 style="font-size:14px;margin:18px 0 6px;color:#b5442e;">月次リセット</h3>
    <p class="miniLabel">小アクア・大アクアの座標登録をまとめて削除できます。攻撃履歴・ルビー集計は残ります。同期設定済みの場合、削除は次回の同期で相手側にも反映されます。</p>
    <button class="btnDelete" type="button" style="width:100%;padding:12px;margin-top:6px;" @click="tracker.clearAquaCoordinates()">小アクア・大アクアの座標を全削除</button>
  </details>
</template>