<script setup lang="ts">
// Bring in someone you already know: a personal link the member sends themselves, through their
// own WhatsApp or text messages. The App sends nothing. Shows the link itself, who came through
// it, and how to take it back.
import { computed, onMounted, ref } from 'vue'
import type { InviteLink } from '../../shared/direct.ts'
import { INVITE_LINK } from '../../shared/direct.ts'
import type { PublicMember } from '../../shared/model.ts'
import { app, attempt, toast } from '../../state/app.ts'
import { inviteText, inviteUrl, loadLinks, messageMember, revokeLink, shareInvite, social } from '../../state/social.ts'
import MemberBadge from '../../ui/MemberBadge.vue'
import { dateTime } from '../../ui/format.ts'

defineProps<{ compact?: boolean }>()
onMounted(() => { void loadLinks() })
const busy = ref(false)
const canShare = typeof navigator.share === 'function'
const newest = computed<InviteLink | null>(() => social.links[0] ?? null)
const joined = computed(() => {
  const seen = new Map<string, PublicMember>()
  for (const link of social.links) for (const member of link.joined) seen.set(member.id, member)
  return [...seen.values()]
})

async function invite(link?: InviteLink): Promise<void> { busy.value = true; await shareInvite(link); busy.value = false }
async function copy(link: InviteLink): Promise<void> {
  try { await navigator.clipboard.writeText(`${inviteText(link)} ${inviteUrl(link)}`); toast('Invite copied. Paste it into a message to the person you want to bring.', 'good') }
  catch { toast('Select the link and copy it by hand.', 'info') }
}
async function introduce(member: PublicMember): Promise<void> {
  if (await attempt('intro.send', { to: member.id, note: 'You came through my invite link.' }, `Introduction sent to ${member.displayName}.`)) void loadLinks()
}
</script>

<template>
  <!-- Folded until wanted, and open by itself once someone has come through a link. -->
  <details class="disclosure bring" :open="joined.length > 0">
    <summary id="bring-title">Bring someone you know <span v-if="joined.length" class="chip leaf num">{{ joined.length }} came</span><span v-else-if="social.links.length" class="chip num">{{ social.links.length }} {{ social.links.length === 1 ? 'link' : 'links' }} open</span></summary>
    <div class="stack tight">
    <p class="small">Make a personal link and send it yourself, by WhatsApp or a text. Whoever opens it starts in your city and can introduce themselves in one tap. The App sends nothing to anyone.</p>

    <template v-if="newest">
      <label class="field">
        <span>Your invite link{{ newest.areaLabel ? ` · “Come find me in ${newest.areaLabel}”` : '' }}</span>
        <input class="input link" type="text" readonly :value="inviteUrl(newest)" aria-label="Your invite link" @focus="($event.target as HTMLInputElement).select()" />
        <small>Works until {{ dateTime(newest.expiresAt) }}. It carries a random code, nothing about you.</small>
      </label>
      <div class="row wrap">
        <button class="btn primary sm" type="button" :disabled="busy" @click="invite(newest)">{{ canShare ? 'Share it' : 'Copy the invite' }}</button>
        <button v-if="canShare" class="btn sm" type="button" @click="copy(newest)">Copy</button>
        <button class="btn sm ghost danger" type="button" @click="revokeLink(newest)">Take it back</button>
        <button v-if="social.links.length < INVITE_LINK.open" class="btn sm ghost" type="button" :disabled="busy" @click="invite()">Make another</button>
      </div>
      <p v-if="social.links.length > 1" class="tiny muted">You have {{ social.links.length }} links open. Taking one back stops it working for everyone who has it.</p>
      <p v-if="app.mode === 'local'" class="tiny muted">Local build: this address only opens on this machine. To try it, open it in another tab and add <code>&amp;as=b</code>.</p>
    </template>
    <div v-else class="row wrap">
      <button class="btn primary" type="button" :disabled="busy" @click="invite()">{{ busy ? 'Making your link…' : 'Invite someone' }}</button>
    </div>

    <template v-if="joined.length">
      <h3 class="label">Came through your link</h3>
      <ul class="plain">
        <li v-for="member in joined" :key="member.id" class="row who">
          <MemberBadge :member-id="member.id" :look="member.look" :size="34" :online="member.online" />
          <span class="grow truncate"><strong>{{ member.displayName }}</strong></span>
          <button v-if="member.relation === 'friend'" class="btn sm" type="button" @click="messageMember(member.id)">Message</button>
          <button v-else-if="member.relation === 'none'" class="btn primary sm" type="button" @click="introduce(member)">Introduce yourself</button>
          <RouterLink v-else-if="member.relation === 'intro-received'" class="btn primary sm" to="/people?tab=requests">Answer them</RouterLink>
          <span v-else class="chip amber">Introduction sent</span>
        </li>
      </ul>
    </template>
    </div>
  </details>
</template>

<style scoped>
.link { font-size: 0.82rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.label { margin-top: 4px; font-size: 0.74rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
.plain { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.who { min-height: 44px; }
code { padding: 1px 5px; border-radius: 6px; background: var(--surface-3); }
a.btn { text-decoration: none; }
@media (pointer: coarse) { .btn.sm { min-height: 40px; } }
</style>
