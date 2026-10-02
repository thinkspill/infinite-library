// Names nobody should see on the leaderboard. Deliberately short: slurs that are unambiguous, so that ordinary names
// and words (Scunthorpe, Dickens, spice, raccoon) pass. Anything subtler is the owner's call (POST /api/admin/player).
// A name is folded first: lower case, accents off, look-alike digits and symbols to letters, and runs of a letter
// cut to one, so "N1GG3R", "niiigger" and "n.i.g.g.e.r" all fold to the same thing.
const ANYWHERE = ['niger', 'fagot', 'retard', 'trany', 'hitler', 'chink', 'wetback', 'beaner', 'raghead', 'towelhead', 'siegheil', 'jewkil'];
// only as a whole word, since inside other words they are innocent ("spice", "dyke" in "Van Dyke" aside)
const WORDS = ['niga', 'nigas', 'nigaz', 'kike', 'kikes', 'kkk', 'fag', 'fags', 'spic', 'spics', 'coon', 'coons', 'cunt', 'cunts', 'dyke', 'rape', 'raper', 'rapist', 'nazi', 'nazis', 'paki', 'pakis', 'tard', 'jap', 'japs', 'gook', 'gooks', 'kys'];
const LOOK = { '0': 'o', '1': 'i', '!': 'i', '|': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't', '+': 't', '8': 'b', '9': 'g', '6': 'g' } as Record<string, string>;
const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[01!|34@5$7+896]/g, c => LOOK[c]).replace(/(\p{L})\1+/gu, '$1');

export function blocked(name: string): boolean {
  const f = fold(name), joined = f.replace(/[^\p{L}]/gu, '').replace(/(\p{L})\1+/gu, '$1');   // n.i.g.g.e.r too
  // "niger" (the country, the river) folds the same as the slur: allowed only when it is spelled with one g
  const slur = (w: string) => w === 'niger' ? /n[^a-z]*[i1!|]+[^a-z]*(g|9|6)[^a-z]*(g|9|6)/i.test(name.replace(/(.)\1+/g, '$1$1')) : true;
  if (ANYWHERE.some(w => joined.includes(w) && slur(w))) return true;
  const words = f.split(/[^\p{L}]+/u).filter(Boolean);
  if (/k{3}/i.test(name.replace(/[^\p{L}]/gu, ''))) return true;   // folding would cut kkk to one k
  return words.some(w => WORDS.includes(w));
}
