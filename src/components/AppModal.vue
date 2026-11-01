<script setup>
import { useUiStore } from '@/stores/uiStore'
const ui = useUiStore()
</script>

<template>
  <div class="modalOverlay" :class="{ show: ui.modal.show }">
    <div class="modalBox">
      <p class="modalMsg">{{ ui.modal.message }}</p>
      <div class="modalBtns">
        <button v-if="ui.modal.withCancel" class="btnCancel" @click="ui.closeModal(false)">キャンセル</button>
        <button class="btnSave" @click="ui.closeModal(true)">OK</button>
      </div>
    </div>
  </div>
</template>