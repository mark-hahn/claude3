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

// Enter in a modal dialog presses its default button (the autofocus one, else its only button)
// unless focus is on something that takes Enter itself. A click on a dialog's text leaves focus on
// the body, where Pane's Enter would act on the blocks behind it. Window capture, ahead of Pane's.
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
  const dialog = [...document.querySelectorAll<HTMLDialogElement>('dialog:modal')].at(-1)
  if (!dialog || (event.target as HTMLElement).closest?.('button, input, textarea, select, a[href], [contenteditable]')) return
  event.preventDefault()
  event.stopImmediatePropagation()
  const buttons = dialog.querySelectorAll('button')
  const button = dialog.querySelector<HTMLButtonElement>('button[autofocus]') ?? (buttons.length === 1 ? buttons[0] : null)
  if (button && !button.disabled) button.click()
}, true)

// Firefox refuses this outside a click. Asked again each page load until answered.
if (Notification.permission === 'default') {
  document.addEventListener('click', () => void Notification.requestPermission(), { capture: true, once: true })
}

createApp(App).mount('#app')
