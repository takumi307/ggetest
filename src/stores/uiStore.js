import { defineStore } from 'pinia'
import { reactive } from 'vue'

export const useUiStore = defineStore('ui', () => {
  const toast = reactive({ show: false, message: '' })
  let toastTimer = null
  function showToast(message) {
    toast.message = message
    toast.show = true
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { toast.show = false }, 1800)
  }

  const modal = reactive({ show: false, message: '', withCancel: false })
  let resolver = null
  function showModal(message, withCancel) {
    if (resolver) { resolver(false); resolver = null }
    return new Promise((resolve) => {
      resolver = resolve
      modal.message = message
      modal.withCancel = !!withCancel
      modal.show = true
    })
  }
  function closeModal(result) {
    modal.show = false
    if (resolver) { resolver(result); resolver = null }
  }
  const showAlert = (message) => showModal(message, false)
  const showConfirm = (message) => showModal(message, true)

  return { toast, modal, showToast, showModal, closeModal, showAlert, showConfirm }
})