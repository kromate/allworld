<template>
  <div class="howto">
    <p class="lead">Build crossing words on the 13 × 13 board. Make the most points before the tiles run out.</p>

    <section>
      <h3>Make a word</h3>
      <p>On your turn, place one or more tiles in a single row or column. The first word of the game must cover the centre and use at least two tiles. After that, every play must connect to a tile already on the board. New tiles cannot leave a gap, and every word they make across and down must be in the word list.</p>
      <p>New tiles on letter squares multiply that tile's points. New tiles on word squares multiply the whole word. A square's bonus counts only the first time it is covered. A blank can stand for any letter and scores zero, even on a letter bonus.</p>
      <div class="example" aria-label="Scoring example">
        <strong>A quick score</strong>
        <p>CAT on plain squares is C 4 + A 2 + T 3 = <b>9 points</b>. If its C is newly placed on a double-letter square, the score is 8 + 2 + 3 = <b>13</b>. On a double-word square instead, the whole word doubles to <b>18</b>.</p>
        <p>Place all seven tiles in one turn for <b>60 extra points</b>.</p>
      </div>
    </section>

    <section>
      <h3>Swap or pass</h3>
      <p>If you cannot make a word you want, swap any number of tiles while at least seven remain in the bag. You draw the same number of new tiles before the old ones go back; swapping uses your turn. You can also pass for no points.</p>
    </section>

    <section>
      <h3>When the game ends</h3>
      <p>The game ends when someone plays their last tile and the bag is empty. Other players lose the points on their racks, and the finisher gains those points. Or, in a two-player game, it ends after four turns in a row with no score (two turns each); everyone loses the points left on their rack. Swaps and passes count as scoreless turns.</p>
    </section>

    <section>
      <h3>Controls</h3>
      <ul>
        <li><strong>Touch or mouse:</strong> drag a tile, or tap a rack tile then tap a square. Tap a tile you placed to return it. Pinch or double-tap to zoom on a phone.</li>
        <li><strong>Keyboard:</strong> arrow keys move between squares; letters place tiles along the chosen direction; Space switches across/down; Backspace takes back your latest tile; Enter plays.</li>
      </ul>
      <p>Use <b>Shuffle</b> to rearrange your rack or <b>Recall</b> to take back all tiles you have placed this turn. The board shows the words and score preview before you play. Swap and pass ask you to confirm because they end your turn.</p>
    </section>

    <p>The practice board uses about 11,000 words. Some real words will be refused there. In the hall, every word is checked against the full list of about 160,000. Practice Hint suggests a word you can edit before playing.</p>

    <p class="credit">Word list: ENABLE (Enhanced North American Benchmark Lexicon), public domain, originated by Alan Beale and M. Cooper.</p>
  </div>
</template>

<style scoped>
.howto { display: flex; flex-direction: column; gap: 16px; color: var(--ink-2); }
.lead { color: var(--ink); font-size: 1rem; }
section { display: grid; gap: 7px; }
h3 { color: var(--ink); font-size: 1rem; }
p, li { font-size: 0.9rem; }
.example { display: grid; gap: 6px; padding: 12px 14px; border-radius: 14px; background: var(--accent-soft); border: 1px solid #f4dfae; }
.example strong { color: var(--accent-ink); }
.example b { color: var(--accent-text); }
ul { margin: 0; padding-left: 20px; display: grid; gap: 7px; }
.credit { padding-top: 10px; border-top: 1px solid var(--line); color: var(--muted); font-size: 0.78rem; }
</style>
