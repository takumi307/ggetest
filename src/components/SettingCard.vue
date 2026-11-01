<script setup>
const props = defineProps({
  title: { type: String, required: true },
  icon: { type: String, default: '' },
  badge: { type: String, default: '' },
  badgeType: { type: String, default: '' },
  open: { type: Boolean, default: false }
})
const initialOpen = props.open // 開閉はユーザー操作に任せる（初期状態だけ反映）
</script>

<template>
  <details class="sCard" :open="initialOpen">
    <summary class="sCardHead">
      <span class="sCardIcon">{{ icon }}</span>
      <span class="sCardTitle">{{ title }}</span>
      <span v-if="badge" class="badge" :class="badgeType">{{ badge }}</span>
      <span class="chev"></span>
    </summary>
    <div class="sCardBody"><slot /></div>
  </details>
</template>
