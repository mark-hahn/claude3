import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import './tooltip.ts'

// Chromium gives focus back after a <dialog> closed with the mouse, but not the text box's caret,
// so typing goes nowhere until focus really leaves and returns. Capture: close doesn't bubble.
document.addEventListener('close', () => {
  const box = document.activeElement
  if (box instanceof HTMLTextAreaElement) {
    box.blur()
    box.focus()
  }
}, true)

// Firefox refuses this outside a click. Asked again each page load until answered.
if (Notification.permission === 'default') {
  document.addEventListener('click', () => void Notification.requestPermission(), { capture: true, once: true })
}

createApp(App).mount('#app')
