<script setup lang="ts">
// How to play Ten Walls, in six short steps with a small picture each. The hall shows this from
// its own "How to play" control; the board shows it from its "?" button.
import { WALLS_EACH, WALLS_TITLE } from '../../../../shared/games/walls.ts'
import MiniBoard from './MiniBoard.vue'
</script>

<template>
  <div class="howto">
    <p class="lead">{{ WALLS_TITLE }} is a race for two. Get your pawn to the far row before the other pawn gets to yours, and use your walls to make their way longer.</p>

    <ol class="steps">
      <li class="step">
        <MiniBoard :cols="5" :rows="5" label="Two pawns on opposite edges. Each races to the row the other started on."
          :pawns="[{ col: 2, row: 0, seat: 0 }, { col: 2, row: 4, seat: 1 }]" :goals="[{ row: 4, seat: 0 }, { row: 0, seat: 1 }]"
          :arrows="[{ from: { col: 1, row: 0 }, to: { col: 1, row: 3 } }, { from: { col: 3, row: 4 }, to: { col: 3, row: 1 } }]" />
        <div>
          <h3>Race to the far row</h3>
          <p>You start in the middle of your own edge. Any square on the far row wins. The real board is nine squares each way.</p>
        </div>
      </li>
      <li class="step">
        <MiniBoard :cols="5" :rows="3" label="A pawn in the middle with the squares above, below, left and right of it marked."
          :pawns="[{ col: 2, row: 1, seat: 0 }]" :dots="[{ col: 2, row: 2 }, { col: 2, row: 0 }, { col: 1, row: 1 }, { col: 3, row: 1 }]" />
        <div>
          <h3>Each turn: one step or one wall</h3>
          <p>Move your pawn one square up, down, left or right, with the jump exception below. Or leave it where it is and place a wall. You cannot pass.</p>
        </div>
      </li>
      <li class="step">
        <MiniBoard :cols="5" :rows="4" label="A wall two squares long lies in front of a pawn, which has to go around it."
          :pawns="[{ col: 2, row: 0, seat: 0 }]" :walls="[{ col: 1, row: 0, dir: 'across', seat: 1 }, { col: 3, row: 1, dir: 'along', seat: 0 }]"
          :arrows="[{ from: { col: 2, row: 0 }, to: { col: 2, row: 1 }, bad: true }, { from: { col: 2, row: 0 }, to: { col: 3, row: 0 } }, { from: { col: 3, row: 0 }, to: { col: 3, row: 1 } }]" />
        <div>
          <h3>Walls block everyone</h3>
          <p>A wall is two squares long and sits in the groove between squares, across or along. Nobody steps through it, you included. Walls cannot overlap or cross. You have {{ WALLS_EACH }}; once they are gone you can only move.</p>
        </div>
      </li>
      <li class="step">
        <MiniBoard :cols="5" :rows="4" label="A pawn in a corner pocket. The wall that would close the pocket is not allowed."
          :pawns="[{ col: 0, row: 0, seat: 0 }]" :walls="[{ col: 1, row: 0, dir: 'along', seat: 1 }, { col: 0, row: 1, dir: 'across', seat: 1, bad: true }]" />
        <div>
          <h3>There must always be a way through</h3>
          <p>You may make a route as long and winding as you like, but a wall that leaves either pawn with no way at all to its goal is refused.</p>
        </div>
      </li>
      <li class="step">
        <MiniBoard :cols="5" :rows="4" label="A pawn jumps straight over the pawn next to it."
          :pawns="[{ col: 1, row: 1, seat: 0 }, { col: 1, row: 2, seat: 1 }]" :dots="[{ col: 1, row: 3 }]"
          :arrows="[{ from: { col: 1, row: 1 }, to: { col: 1, row: 3 } }]" />
        <div>
          <h3>Jump the other pawn</h3>
          <p>When the pawns are next to each other, you may jump straight over to the square behind.</p>
        </div>
      </li>
      <li class="step">
        <MiniBoard :cols="5" :rows="4" label="A wall behind the other pawn blocks the jump, so the pawn may step to either side of it instead."
          :pawns="[{ col: 2, row: 1, seat: 0 }, { col: 2, row: 2, seat: 1 }]" :walls="[{ col: 1, row: 2, dir: 'across', seat: 1 }]"
          :dots="[{ col: 1, row: 2 }, { col: 3, row: 2 }]"
          :arrows="[{ from: { col: 2, row: 1 }, to: { col: 1, row: 2 } }, { from: { col: 2, row: 1 }, to: { col: 3, row: 2 } }]" />
        <div>
          <h3>Or step around it</h3>
          <p>If a wall or the edge of the board is right behind the other pawn, the jump is blocked. Step to the square on either side of that pawn instead, the only time a pawn moves diagonally.</p>
        </div>
      </li>
    </ol>

    <div class="tips">
      <h3>Playing it</h3>
      <ul>
        <li><strong>Touch.</strong> Tap a marked square, or use the larger Move to buttons below the board. To place a wall, switch to Wall, tap where it should go, use the adjustment arrows or turn it if you need to, then tap it again or press Place.</li>
        <li><strong>Mouse.</strong> Click a marked square to move. Click a groove to try a wall there and click it again to place it, or drag a wall from your rack.</li>
        <li><strong>Keyboard.</strong> Click or tab to the board. <span class="kbd">←</span> <span class="kbd">↑</span> <span class="kbd">→</span> <span class="kbd">↓</span> move your pawn. <span class="kbd">W</span> switches to placing a wall; the arrows then slide it, <span class="kbd">R</span> turns it and <span class="kbd">Enter</span> places it. <span class="kbd">Esc</span> goes back to moving.</li>
        <li><strong>Routes.</strong> Switch on Routes to see each side's shortest way and how many steps it takes. A wall you are trying shows what it would change before you place it. Routes ignore the other pawn, so jumps can change the actual number of turns.</li>
      </ul>
      <p class="muted small">A wall that costs them three steps and you none is worth more than a step forward. Keep a few walls for the end.</p>
    </div>
  </div>
</template>

<style scoped>
.howto { display: flex; flex-direction: column; gap: 14px; container-type: inline-size; }
.lead { color: var(--ink-2); }
.steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; grid-template-columns: 1fr; }
.step { display: grid; grid-template-columns: 112px 1fr; gap: 12px; align-items: center; padding: 10px; border-radius: 14px; background: var(--surface-2); border: 1px solid var(--line); }
.step h3 { margin-bottom: 3px; }
.step p { font-size: 0.88rem; color: var(--ink-2); }
.tips { padding: 12px 14px; border-radius: 14px; background: var(--accent-soft); border: 1px solid #f4dfae; display: grid; gap: 8px; }
.tips ul { margin: 0; padding-left: 18px; display: grid; gap: 6px; font-size: 0.88rem; color: #5c3d08; }
@container (min-width: 640px) { .steps { grid-template-columns: 1fr 1fr; } }
</style>
