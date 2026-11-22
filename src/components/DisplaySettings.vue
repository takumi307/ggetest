<script setup>
import { reactive, watch } from 'vue'
import { useTrackerStore } from '@/stores/trackerStore'
import { useSyncStore } from '@/stores/syncStore'
import { DISPLAY_TYPE_LIST, DISTANCE_TYPES, FORT_TYPES } from '@/utils/constants'
import { isAquaFamily } from '@/utils/helpers'
import ToggleSwitch from './ToggleSwitch.vue'

const tracker = useTrackerStore()
const sync = useSyncStore()

/* 編集用の下書き。「保存」を押したときだけ本体へ反映する */
const draft = reactive({ enabled: {}, near50: {}, nearDistance: {}, home: {}, storm: {}, shareStorm: false })
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
  FORT_TYPES.forEach((t) => {
    const h = (s.homeCoords && s.homeCoords[t]) || {}
    home[t] = { x: h.x == null ? '' : h.x, y: h.y == null ? '' : h.y }
  })
  draft.home = home
  draft.storm = { ...tracker.stormHome() }
  draft.shareStorm = !!sync.stormProfile()?.enabled
}
loadDraft()
watch(() => tracker.settings, loadDraft, { deep: true }) // 引き継ぎ読み込みなどで設定が変わったら下書きも更新
watch([() => tracker.userId, () => sync.stormProfile()?.updatedAt], loadDraft)

function save() { tracker.saveSettings(draft) }
</script>

<template>
  <div>
    <div class="subHead">一覧に表示する種類</div>
    <p class="miniLabel" style="margin:0 0 4px;">オフにしても登録データは削除されず、一覧・攻撃可能タブで非表示になります。表示をオフにした要塞・ドラゴンは、Discord通知の対象からも外れます。</p>
    <ToggleSwitch v-for="[t, name] in DISPLAY_TYPE_LIST" :key="t" v-model="draft.enabled[t]" :label="name" />

    <div class="subHead">自分の座標と距離</div>
    <p class="miniLabel" style="margin:0 0 4px;">自分の座標を保存するとカードに距離が表示されます。距離で絞り込むと、上限より遠い座標を一覧から外します。要塞・ドラゴンはDiscord通知の対象からも外れます。</p>
    <div class="distGroup">
      <div class="subHead">嵐の島（大・小アクア共通）</div>
      <div class="rowFields">
        <div class="field"><label for="storm-home-x">自分のX</label><input id="storm-home-x" v-model="draft.storm.x" type="number"></div>
        <div class="field"><label for="storm-home-y">自分のY</label><input id="storm-home-y" v-model="draft.storm.y" type="number"></div>
      </div>
      <ToggleSwitch v-if="sync.isConfigured('aqua') || draft.shareStorm" v-model="draft.shareStorm" label="最寄り比較に参加する"
        hint="参加すると座標をサーバーに保存します。相手の画面には、最寄りの参加者のIDと距離が表示されます。設定は次の同期で反映されます。" />
      <p v-else class="miniLabel">最寄り比較は共有サーバーに接続すると使えます。</p>
    </div>
    <div v-for="c in tracker.nearCounts" :key="c.type" class="distGroup">
      <ToggleSwitch
        v-model="draft.near50[c.type]"
        :label="c.name + '：距離で絞り込む'"
        :hint="c.hasHome ? '上限' + c.limit + '以内：' + c.count + '件' : '自分の座標を入力すると有効になります'"
      />
      <div class="rowFields" style="margin-top:10px;">
        <template v-if="!isAquaFamily(c.type)">
          <div class="field"><label>自分のX</label><input v-model="draft.home[c.type].x" type="number"></div>
          <div class="field"><label>自分のY</label><input v-model="draft.home[c.type].y" type="number"></div>
        </template>
        <div class="field"><label>上限距離</label><input v-model="draft.nearDistance[c.type]" type="number" min="0"></div>
      </div>
    </div>

    <div class="btnRow">
      <button class="btnPrimary" type="button" @click="save">保存</button>
    </div>
  </div>
</template>
