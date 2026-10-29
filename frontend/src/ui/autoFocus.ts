/** Callback ref that focuses an element once, when it mounts (popover search fields etc.). */
export const autoFocus = (el: HTMLElement | null) => { if (el) requestAnimationFrame(() => el.focus({ preventScroll: true })); };
