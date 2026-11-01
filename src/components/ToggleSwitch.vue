<script setup>
defineProps({
  modelValue: { type: Boolean, default: false },
  label: { type: String, default: '' },
  hint: { type: String, default: '' }
})
defineEmits(['update:modelValue'])
</script>

<template>
  <label class="toggleRow">
    <span class="toggleText">
      <span class="toggleLabel">{{ label }}</span>
      <span v-if="hint" class="toggleHint">{{ hint }}</span>
    </span>
    <input class="toggleInput" type="checkbox" :checked="modelValue" @change="$emit('update:modelValue', $event.target.checked)">
    <span class="toggleTrack"></span>
  </label>
</template>
