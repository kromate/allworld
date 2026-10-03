<script setup lang="ts">
// The home route. The world is the shell's one shared stage (App.vue mounts WorldStage for every
// route), so this page draws nothing: it only gives "/" a real component, and marks that no window
// is open beside the world.
</script>

<template>
  <span class="world-route" hidden aria-hidden="true"></span>
</template>
