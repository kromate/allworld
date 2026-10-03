<script setup lang="ts">
// How to play chess: the aim, how each piece moves, the three special moves, and every way a
// game here can end — short, with a small picture each. The hall shows this from its "How to
// play" control; the board shows it from its "?" button.
import ChessPiece from './ChessPiece.vue'
import MiniBoard from './MiniBoard.vue'
import type { Mark } from './MiniBoard.vue'

const dots = (...names: string[]): Record<string, Mark> => Object.fromEntries(names.map(name => [name, 'dot' as Mark]))
const EMPTY = '.....'

const PIECES: { name: string; text: string; label: string; rows: string[]; marks: Record<string, Mark> }[] = [
  { name: 'King', text: 'One square in any direction. It may never step onto a square that is attacked.', label: 'A king in the middle with the eight squares around it marked.', rows: [EMPTY, EMPTY, '..K..', EMPTY, EMPTY], marks: dots('d5', 'e5', 'f5', 'd4', 'f4', 'd3', 'e3', 'f3') },
  { name: 'Queen', text: 'Any distance in a straight line or along a diagonal. The strongest piece.', label: 'A queen in the middle with every square in line with it marked, straight and diagonal.', rows: [EMPTY, EMPTY, '..Q..', EMPTY, EMPTY], marks: dots('c6', 'e6', 'g6', 'd5', 'e5', 'f5', 'c4', 'd4', 'f4', 'g4', 'd3', 'e3', 'f3', 'c2', 'e2', 'g2') },
  { name: 'Rook', text: 'Any distance in a straight line: along its row or up and down its column.', label: 'A rook in the middle with the squares along its row and column marked.', rows: [EMPTY, EMPTY, '..R..', EMPTY, EMPTY], marks: dots('e6', 'e5', 'c4', 'd4', 'f4', 'g4', 'e3', 'e2') },
  { name: 'Bishop', text: 'Any distance along a diagonal, so it stays on squares of one colour all game.', label: 'A bishop in the middle with the squares on its two diagonals marked.', rows: [EMPTY, EMPTY, '..B..', EMPTY, EMPTY], marks: dots('c6', 'g6', 'd5', 'f5', 'd3', 'f3', 'c2', 'g2') },
  { name: 'Knight', text: 'Two squares one way and one to the side, like an L. The only piece that jumps over others.', label: 'A knight in the middle with the eight squares an L-shape away marked.', rows: [EMPTY, EMPTY, '..N..', EMPTY, EMPTY], marks: dots('d6', 'f6', 'c5', 'g5', 'c3', 'g3', 'd2', 'f2') },
  { name: 'Pawn', text: 'It moves one square forward, or two from its starting square if both squares are clear. It cannot jump over a piece. It captures only one square diagonally forward, and never moves back.', label: 'A white pawn on d2 may move to d3 or, if d3 is clear, d4. Another white pawn on f4 may move to f5 or capture the black pawn on g5.', rows: [EMPTY, '....p', '...P.', EMPTY, '.P...'], marks: { ...dots('d3', 'd4', 'f5'), g5: 'take' } },
]
</script>

<template>
  <div class="howto">
    <p class="lead">Two armies of sixteen. White moves first, then the players take turns, one move each. You win by attacking the other king so it cannot escape: <strong>checkmate</strong>.</p>

    <section>
      <h3 class="head">How the pieces move</h3>
      <p class="small note">A piece moves to an empty square, or onto an enemy piece to capture it. Apart from the knight, nothing jumps over anything.</p>
      <ul class="pieces">
        <li v-for="piece in PIECES" :key="piece.name" class="step">
          <MiniBoard :rows="piece.rows" origin="c2" :marks="piece.marks" :label="piece.label" />
          <div>
            <h4>{{ piece.name }}</h4>
            <p>{{ piece.text }}</p>
          </div>
        </li>
      </ul>
    </section>

    <section>
      <h3 class="head">Three special moves</h3>
      <ul class="specials">
        <li class="step wide">
          <div class="strips">
            <MiniBoard :rows="['R...K..R']" :marks="{ c1: 'dot', g1: 'dot' }" label="White's king on e1 with a rook in each corner and nothing between them. The king may go two squares towards either rook." />
            <MiniBoard :rows="['R....RK.']" :marks="{ e1: 'last', g1: 'last' }" label="After castling on the king's side: the king is on g1 and the rook has jumped over it to f1." />
          </div>
          <div>
            <h4>Castling</h4>
            <p>Once a game, the king may move two squares towards a rook, and that rook jumps over to stand beside it. Allowed only when neither of them has moved, the squares between are empty, and the king is not in check and does not cross or land on an attacked square.</p>
          </div>
        </li>
        <li class="step">
          <MiniBoard :rows="['....', '....', '.pP.', '....']" origin="c4" :marks="{ d7: 'last', d5: 'last', d6: 'dot' }" label="A black pawn has just moved two squares and landed beside a white pawn. The white pawn may capture it by moving to the square it skipped." />
          <div>
            <h4>Capturing in passing</h4>
            <p>When a pawn moves two squares and lands right beside an enemy pawn, that pawn may capture it as if it had moved only one — on the very next move, or not at all. Players call it <em>en passant</em>.</p>
          </div>
        </li>
        <li class="step">
          <MiniBoard :rows="['....', '..P.', '....', '....']" origin="c5" :marks="{ e8: 'dot' }" label="A white pawn one step from the last row." />
          <div>
            <h4>Promotion</h4>
            <p>A pawn that reaches the far row becomes a piece of your choice, usually a queen.</p>
            <p class="choices" role="img" aria-label="Queen, rook, bishop or knight">
              <span v-for="kind in 'QRBN'" :key="kind"><ChessPiece :piece="kind" /></span>
            </p>
          </div>
        </li>
      </ul>
    </section>

    <section>
      <h3 class="head">Check, and how a game ends</h3>
      <ul class="specials">
        <li class="step">
          <MiniBoard :rows="['R.k.', '.ppp', '....', '....']" origin="e5" :marks="{ g8: 'check' }" label="A white rook attacks the black king along the back row. The king's own pawns block every way out: checkmate." />
          <div>
            <h4>Check and checkmate</h4>
            <p>A king under attack is in check, and the next move must end it: move the king, block, or capture the attacker. If nothing does, it is checkmate and the game is won.</p>
          </div>
        </li>
        <li class="step">
          <MiniBoard :rows="['...k', '.K..', '..Q.', '....']" origin="e5" label="The black king in the corner is not attacked, but every square it could move to is: stalemate." />
          <div>
            <h4>Stalemate</h4>
            <p>If the player to move is not in check but has no legal move at all, the game is a draw. Take care when you are far ahead.</p>
          </div>
        </li>
      </ul>
      <div class="ends">
        <p><strong>Automatic draws.</strong> The board ends the game if the same position comes up for the third time, if 50 moves by each side pass without a capture or pawn move, or if neither side has enough material to checkmate — for example, king against king or with just one bishop or knight. This game applies these draws automatically; there is no claim-draw button.</p>
        <p><strong>Ending it yourselves.</strong> You may resign, or agree a draw with the other player. Resigning loses unless the other side has no possible mating material, which is a draw.</p>
        <p><strong>The clock.</strong> Run out of time and you lose — unless the other side could never checkmate with what it has left, which is a draw.</p>
      </div>
    </section>

    <div class="tips">
      <h3>Playing it</h3>
      <ul>
        <li><strong>Touch.</strong> Tap a piece, then tap one of the marked squares. Or press and drag it there. A dot is an empty square it can go to; a ring is a piece it can capture.</li>
        <li><strong>Mouse.</strong> Click a piece and then a square, or drag and drop.</li>
        <li><strong>Keyboard.</strong> Tab to the board. <span class="kbd">←</span> <span class="kbd">↑</span> <span class="kbd">→</span> <span class="kbd">↓</span> move between squares, <span class="kbd">Enter</span> picks a piece up and puts it down, <span class="kbd">Esc</span> lets go.</li>
        <li><strong>Around the board.</strong> Your side is at the bottom; the arrows button turns the board round. Captured pieces sit beside each name with who is ahead. Sound is off until you switch it on.</li>
        <li><strong>The computer.</strong> Easy plays like a beginner: it takes free pieces but misses longer plans. Medium searches about three to four half-moves ahead (roughly two full moves). Hard searches further and knows some common openings.</li>
      </ul>
      <p class="muted small">Bring your knights and bishops out early, castle, and before every move ask what the other side's last move attacks.</p>
    </div>
  </div>
</template>

<style scoped>
.howto { display: flex; flex-direction: column; gap: 16px; container-type: inline-size; }
.lead { color: var(--ink-2); }
section { display: flex; flex-direction: column; gap: 8px; }
.head { font-size: 1rem; }
.note { color: var(--ink-2); }
.pieces, .specials { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; grid-template-columns: 1fr; }
.step { display: grid; grid-template-columns: 104px 1fr; gap: 12px; align-items: center; padding: 10px; border-radius: 14px; background: var(--surface-2); border: 1px solid var(--line); }
.step h4 { margin: 0 0 3px; font-size: 0.95rem; }
.step p { font-size: 0.88rem; color: var(--ink-2); }
.step.wide { grid-template-columns: 1fr; }
.strips { display: grid; gap: 8px; max-width: 420px; }
.choices { display: flex; gap: 2px; margin-top: 6px; }
.choices span { width: 30px; height: 30px; }
.ends { display: grid; gap: 6px; padding: 12px 14px; border-radius: 14px; background: var(--surface-2); border: 1px solid var(--line); font-size: 0.88rem; color: var(--ink-2); }
.tips { padding: 12px 14px; border-radius: 14px; background: var(--accent-soft); border: 1px solid #f4dfae; display: grid; gap: 8px; }
.tips ul { margin: 0; padding-left: 18px; display: grid; gap: 6px; font-size: 0.88rem; color: #5c3d08; }
@container (min-width: 600px) {
  .pieces, .specials { grid-template-columns: 1fr 1fr; }
  .step.wide { grid-column: 1 / -1; grid-template-columns: 1fr 1fr; }
}
</style>
