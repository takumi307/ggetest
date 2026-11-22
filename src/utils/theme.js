const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
const storageKey = 'ggeTheme'
let preference = 'system'

try {
  const saved = localStorage.getItem(storageKey)
  if (saved === 'light' || saved === 'dark') preference = saved
} catch {}

function applyTheme() {
  const theme = preference === 'system' ? (systemTheme.matches ? 'dark' : 'light') : preference
  const root = document.documentElement
  root.dataset.theme = theme
  const color = getComputedStyle(root).getPropertyValue('--page').trim()
  if (color) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color)
}

export function initTheme() {
  applyTheme()
  systemTheme.addEventListener('change', applyTheme)
}

export function getThemePreference() { return preference }

export function setThemePreference(value) {
  preference = value
  try { localStorage.setItem(storageKey, value) } catch {}
  applyTheme()
}
