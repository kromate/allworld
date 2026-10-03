<script setup lang="ts">
import PanelPage from './PanelPage.vue'
</script>

<template>
  <PanelPage title="That page does not exist">
    <div class="empty">
      <div class="art" aria-hidden="true">🧭</div>
      <p class="small">The link may be old or mistyped. Your place in the world is unchanged.</p>
      <RouterLink class="btn primary" to="/">Back to the world</RouterLink>
    </div>
  </PanelPage>
</template>
