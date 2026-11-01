<script setup>
import { reactive, watch } from 'vue'
import { useTrackerStore } from '@/stores/trackerStore'
import { DISPLAY_TYPE_LIST, DISTANCE_TYPES } from '@/utils/constants'
import ToggleSwitch from './ToggleSwitch.vue'

const tracker = useTrackerStore()

/* 編集用の下書き。「保存」を押したときだけ本体へ反映する */
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

function save() { tracker.saveSettings(draft) }
</script>

<template>
  <div>
    <div class="subHead">一覧に表示する種類</div>
    <p class="miniLabel" style="margin:0 0 4px;">オフにしても登録データは削除されず、一覧・攻撃可能タブで非表示になります。表示をオフにした要塞・ドラゴンは、Discord通知の対象からも外れます。</p>
    <ToggleSwitch v-for="[t, name] in DISPLAY_TYPE_LIST" :key="t" v-model="draft.enabled[t]" :label="name" />

    <div class="subHead">距離で絞り込む（自分の城からの距離）</div>
    <p class="miniLabel" style="margin:0 0 4px;">自分の座標を入力すると、上限距離以内のものだけを表示します。距離の外にあるものは、Discord通知の対象にもなりません。</p>
    <div v-for="c in tracker.nearCounts" :key="c.type" class="distGroup">
      <ToggleSwitch
        v-model="draft.near50[c.type]"
        :label="c.name + '：距離で絞り込む'"
        :hint="c.hasHome ? '上限' + c.limit + '以内：' + c.count + '件' : '自分の座標を入力すると有効になります'"
      />
      <div class="rowFields" style="margin-top:10px;">
        <div class="field"><label>自分のX</label><input v-model="draft.home[c.type].x" type="number"></div>
        <div class="field"><label>自分のY</label><input v-model="draft.home[c.type].y" type="number"></div>
        <div class="field"><label>上限距離</label><input v-model="draft.nearDistance[c.type]" type="number" min="0"></div>
      </div>
    </div>

    <div class="btnRow">
      <button class="btnPrimary" type="button" @click="save">保存</button>
    </div>
  </div>
</template>
