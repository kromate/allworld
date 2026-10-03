// Words taken out of the word list before it is shipped: slurs aimed at people for their race,
// ethnicity, religion, sexuality or disability, with their inflections. Everyday swear words are
// not here (they insult nobody in particular and players expect them in a word game), and words
// with an ordinary first meaning stay in ("chink" a gap, "retard" to slow, "queer" odd).
//
// The entries are written in ROT13 (each letter moved 13 places) so that this file is not itself
// a page of slurs for whoever opens it. `node service/arena/words/build.ts --blocked` prints them
// in clear. To add one: ROT13 it and add it here, then rebuild the lists.
const ROT13 = ''
  + 'nob nobf obpur obpurf obuhax obuhaxf ohpxen ohpxenf puvaxl pbba pbbaf qntb qntbrf qntbf qnexrl qnexrlf qnexvr qnexvrf qnexl qlxr qlxrq qlxrf qlxrl snt '
  + 'snttrq snttvat snttbg snttbgrq snttbgvat snttbgvatf snttbgevrf snttbgel snttbgf snttbgl snttl sntf tbyyvjbt tbyyvjbtt tbyyvjbttf tbyyvjbtf tbyyljbt '
  + 'tbyyljbtf tbbx tbbxf tbbxl tlc tlccrq tlccre tlccref tlccvat tlcf tlcfgre tlcfgref unbyr unbyrf uror urorf ubzb ubzbf ubaxrl ubaxrlf ubaxvr ubaxvrf '
  + 'ubaxl wrj wrjrq wrjvat wrjf wvtnobb wvtnobbf xnssve xnssvef xnsve xnsvef xvxr xvxrf xenhg xenhgf yrm yrmmrf yrmmvr yrmmvrf yrmml zvpx zvpxf zbatbybvq '
  + 'zbatbybvqf zhynggb zhynggbrf zhynggbf anapr anaprf anapvrf anapl artebvq artebvqf avttre avttref bpgbebba bpgbebbaf bsnl bsnlf crpxrejbbq crpxrejbbqf '
  + 'cvpxnavaavrf cvpxnavaal cbbs cbbsf cbbsgnu cbbsgnuf cbbsgre cbbsgref cbbsl cbbir cbbirf dhnqebba dhnqebbaf erqfxva erqfxvaf fnzob fnzobf furravr '
  + 'furravrf fulybpx fulybpxrq fulybpxvat fulybpxf fcnm fcnmmrf fcvp fcvpx fcvpxf fcvpf fcvx fcvxf fdhnj fdhnjf jrgonpx jrgonpxf juvgrl juvgrlf jbt jbtf '
  + 'jbc jbcf lvq lvqf '

const turn = (text: string): string => text.replace(/[a-z]/g, letter => String.fromCharCode(((letter.charCodeAt(0) - 97 + 13) % 26) + 97))

/** Lower-case words that are never accepted. */
export const BLOCKED: ReadonlySet<string> = new Set(turn(ROT13).split(' ').filter(Boolean))
