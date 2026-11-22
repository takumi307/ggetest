import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './assets/main.css'
import { initTheme } from './utils/theme'

initTheme()
createApp(App).use(createPinia()).mount('#app')
