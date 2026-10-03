<script setup lang="ts">
// A street bend meeting a location ring, using the App's amber accent.
defineProps<{ size?: number }>()
</script>

<template>
  <svg :width="size ?? 34" :height="size ?? 34" viewBox="0 0 40 40" aria-hidden="true">
    <defs>
      <linearGradient id="nw-mark" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#ffc64d" />
        <stop offset="1" stop-color="#f39a00" />
      </linearGradient>
    </defs>
    <rect width="40" height="40" rx="12" fill="#1c1a24" />
    <path d="M8 30c7 0 9-5 12-10s5-10 12-10" fill="none" stroke="#3a3648" stroke-width="7" stroke-linecap="round" />
    <path d="M8 30c7 0 9-5 12-10s5-10 12-10" fill="none" stroke="url(#nw-mark)" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="4 4.5" />
    <circle cx="20" cy="20" r="6.2" fill="url(#nw-mark)" />
    <circle cx="20" cy="20" r="2.4" fill="#1c1a24" />
    <circle cx="31.5" cy="10" r="2.6" fill="#f0553a" />
    <circle cx="8.5" cy="30" r="2.6" fill="#2f8fd6" />
  </svg>
</template>
