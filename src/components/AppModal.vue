<script setup>
import { ref, watch } from 'vue'
import { useUiStore } from '@/stores/uiStore'
const ui = useUiStore()
const dialog = ref(null)

watch(() => ui.modal.show, (open) => {
  if (open && !dialog.value.open) dialog.value.showModal()
  else if (!open && dialog.value.open) dialog.value.close()
}, { flush: 'post' })
</script>

<template>
  <dialog ref="dialog" class="modalBox" aria-labelledby="modal-message" @cancel.prevent="ui.closeModal(false)">
    <p id="modal-message" class="modalMsg">{{ ui.modal.message }}</p>
    <div class="modalBtns">
      <button v-if="ui.modal.withCancel" type="button" class="btnCancel" autofocus @click="ui.closeModal(false)">キャンセル</button>
      <button type="button" class="btnSave" :autofocus="!ui.modal.withCancel" @click="ui.closeModal(true)">OK</button>
    </div>
  </dialog>
</template>
