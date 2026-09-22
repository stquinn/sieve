// @ts-check
// emoji-catalog.js — the `:` picker's candidates.
//
// An entry is a LITERAL UNICODE CHARACTER, a name, and the words someone might
// reach for instead of the name. Nothing is generated and nothing is fetched:
// the table is read at module load, the search is a local filter, and an
// accepted entry puts its character into the prose exactly as a pasted one
// would — the system emoji font draws it, here and in every other reader.
//
// THE OLD-SCHOOL SEQUENCES LIVE HERE AS KEYWORDS. `:)` is the trigger `:` and
// the prefix `)`, so the smiley answers to `)` the way it answers to `happy`.
// That is why there is no second autoformat mechanism.

import { ContractViolation } from '../contract/sieve-block.js'

/**
 * A curated entry: `[glyph, name, ...keywords]`. Written as a tuple because the
 * table is read by a person adding a line to it, and a line of objects would be
 * four times the width for the same three facts.
 * @typedef {[string, string, ...string[]]} EmojiSpec
 */

export class Emoji {
  /** @type {string} */ #glyph
  /** @type {string} */ #name
  /** @type {readonly string[]} */ #keywords

  /** @param {EmojiSpec} spec */
  constructor(spec) {
    if (!spec || !spec[0] || !spec[1]) throw new ContractViolation('an Emoji needs a glyph and a name')
    this.#glyph = spec[0]
    this.#name = spec[1]
    this.#keywords = Object.freeze(spec.slice(2).map((k) => k.toLowerCase()))
    Object.freeze(this)
  }

  /** @returns {string} the literal Unicode character inserted into the prose */
  get glyph() { return this.#glyph }

  /** @returns {string} what the caption calls it */
  get name() { return this.#name }

  /** @returns {readonly string[]} the other words it answers to, lower-cased */
  get keywords() { return this.#keywords }

  /**
   * The words this entry is matched on: its name and its keywords alike.
   * @returns {string[]}
   */
  get terms() { return [this.#name.toLowerCase()].concat(/** @type {string[]} */ (this.#keywords)) }
}

/** @type {EmojiSpec[]} */
const TABLE = [
  // faces
  ['😀', 'grinning', 'happy', 'smile', 'joy', 'd'],
  ['😃', 'smiley', 'happy', 'grin'],
  ['😄', 'smile', 'happy', 'laugh'],
  ['😁', 'beaming', 'grin', 'teeth'],
  ['😆', 'laughing', 'lol', 'haha'],
  ['😅', 'sweat smile', 'relief', 'phew'],
  ['🤣', 'rofl', 'lol', 'rolling', 'haha'],
  ['😂', 'joy', 'lol', 'tears', 'crying laughing'],
  ['🙂', 'slight smile', 'smile', ')', '-)'],
  ['🙃', 'upside down', 'irony', 'sarcasm'],
  ['😉', 'wink', 'flirt', ';)'],
  ['😊', 'blush', 'happy', 'shy'],
  ['😇', 'innocent', 'halo', 'angel'],
  ['🥰', 'smiling with hearts', 'love', 'adore'],
  ['😍', 'heart eyes', 'love', 'crush'],
  ['😘', 'kiss', 'blowing kiss', 'love'],
  ['😋', 'yum', 'tasty', 'delicious'],
  ['😛', 'tongue', 'cheeky', 'p'],
  ['😜', 'wink tongue', 'cheeky', 'silly'],
  ['🤪', 'zany', 'goofy', 'crazy'],
  ['🤨', 'raised eyebrow', 'skeptical', 'suspicious'],
  ['🧐', 'monocle', 'scrutiny', 'inspect'],
  ['🤓', 'nerd', 'glasses', 'geek'],
  ['😎', 'sunglasses', 'cool', 'b)'],
  ['🥳', 'partying', 'celebrate', 'party'],
  ['😏', 'smirk', 'smug', 'sly'],
  ['😒', 'unamused', 'meh', 'unimpressed'],
  ['😞', 'disappointed', 'sad'],
  ['😔', 'pensive', 'sad', 'dejected'],
  ['😟', 'worried', 'concerned'],
  ['🙁', 'slight frown', 'sad', '('],
  ['☹️', 'frowning', 'sad', '-('],
  ['😣', 'persevere', 'struggle'],
  ['😖', 'confounded', 'frustrated'],
  ['😫', 'tired', 'exhausted', 'fed up'],
  ['😩', 'weary', 'tired'],
  ['🥺', 'pleading', 'puppy eyes', 'please'],
  ['😢', 'cry', 'sad', 'tear', "'("],
  ['😭', 'sob', 'bawling', 'crying'],
  ['😤', 'triumph', 'huff', 'determined'],
  ['😠', 'angry', 'mad'],
  ['😡', 'rage', 'furious', 'pouting'],
  ['🤬', 'cursing', 'swearing', 'symbols'],
  ['🤯', 'mind blown', 'exploding head', 'wow'],
  ['😳', 'flushed', 'embarrassed', 'blush'],
  ['🥵', 'hot face', 'overheated', 'sweating'],
  ['🥶', 'cold face', 'freezing'],
  ['😱', 'scream', 'fear', 'shock'],
  ['😨', 'fearful', 'scared'],
  ['😰', 'anxious', 'nervous', 'sweat'],
  ['😥', 'sad relieved', 'disappointed', 'whew'],
  ['😓', 'downcast sweat', 'exhausted'],
  ['🤗', 'hugging', 'hug', 'embrace'],
  ['🤔', 'thinking', 'hmm', 'ponder'],
  ['🤭', 'hand over mouth', 'oops', 'giggle'],
  ['🤫', 'shushing', 'quiet', 'secret'],
  ['🤥', 'lying', 'pinocchio', 'liar'],
  ['😶', 'no mouth', 'speechless', 'silence'],
  ['😐', 'neutral', 'meh', '|'],
  ['😑', 'expressionless', 'blank'],
  ['😬', 'grimacing', 'awkward', 'eek'],
  ['🙄', 'eye roll', 'whatever', 'annoyed'],
  ['😯', 'hushed', 'surprised', 'o'],
  ['😮', 'open mouth', 'wow', 'surprise'],
  ['😲', 'astonished', 'shocked', 'gasp'],
  ['🥱', 'yawn', 'bored', 'tired'],
  ['😴', 'sleeping', 'zzz', 'asleep'],
  ['🤤', 'drooling', 'want'],
  ['😪', 'sleepy', 'tired'],
  ['😵', 'dizzy', 'knocked out', 'x'],
  ['🤐', 'zipper mouth', 'silence', 'sealed'],
  ['🥴', 'woozy', 'drunk', 'tipsy'],
  ['🤢', 'nauseated', 'sick', 'gross'],
  ['🤮', 'vomiting', 'sick', 'puke'],
  ['🤧', 'sneezing', 'sick', 'tissue'],
  ['😷', 'mask', 'sick', 'medical'],
  ['🤒', 'thermometer face', 'sick', 'fever'],
  ['🤕', 'bandage face', 'hurt', 'injured'],
  ['🤠', 'cowboy', 'yeehaw', 'hat'],
  ['🤑', 'money mouth', 'rich', 'cash'],
  ['👻', 'ghost', 'boo', 'halloween'],
  ['💀', 'skull', 'dead', 'danger'],
  ['👽', 'alien', 'ufo', 'extraterrestrial'],
  ['🤖', 'robot', 'bot', 'ai'],
  ['💩', 'poop', 'crap', 'rubbish'],
  ['🤡', 'clown', 'joker'],
  ['😈', 'smiling devil', 'imp', 'mischief'],
  ['🙈', 'see no evil', 'monkey', 'hide'],
  ['🙉', 'hear no evil', 'monkey'],
  ['🙊', 'speak no evil', 'monkey'],

  // hands + people
  ['👍', 'thumbs up', 'yes', 'approve', 'lgtm', '+1'],
  ['👎', 'thumbs down', 'no', 'disapprove', '-1'],
  ['👌', 'ok hand', 'perfect', 'fine'],
  ['🤌', 'pinched fingers', 'italian', 'gesture'],
  ['✌️', 'victory', 'peace', 'v'],
  ['🤞', 'crossed fingers', 'luck', 'hope'],
  ['🤟', 'love you gesture', 'ily'],
  ['🤘', 'horns', 'rock', 'metal'],
  ['🤙', 'call me', 'shaka', 'hang loose'],
  ['👈', 'point left', 'left'],
  ['👉', 'point right', 'right', 'this'],
  ['👆', 'point up', 'up', 'above'],
  ['👇', 'point down', 'down', 'below'],
  ['☝️', 'index up', 'one', 'attention'],
  ['✋', 'raised hand', 'stop', 'high five'],
  ['🖐️', 'hand splayed', 'five', 'stop'],
  ['🖖', 'vulcan', 'spock', 'live long'],
  ['👋', 'wave', 'hello', 'bye', 'hi'],
  ['🤝', 'handshake', 'deal', 'agree'],
  ['🙏', 'pray', 'thanks', 'please', 'namaste'],
  ['✍️', 'writing hand', 'write', 'note'],
  ['👏', 'clap', 'applause', 'bravo'],
  ['🙌', 'raised hands', 'celebrate', 'hooray'],
  ['🤲', 'open palms', 'offer'],
  ['💪', 'muscle', 'strong', 'flex'],
  ['🧠', 'brain', 'think', 'smart'],
  ['👀', 'eyes', 'look', 'watching'],
  ['👁️', 'eye', 'see'],
  ['🫡', 'salute', 'yes sir', 'respect'],
  ['🤦', 'facepalm', 'sigh', 'disbelief'],
  ['🤷', 'shrug', 'dunno', 'idk'],
  ['🙋', 'raising hand', 'question', 'volunteer'],
  ['🙇', 'bow', 'sorry', 'apology'],
  ['🕵️', 'detective', 'spy', 'investigate'],
  ['👶', 'baby', 'infant'],
  ['🧑‍💻', 'technologist', 'developer', 'coder', 'programmer'],
  ['🧑‍🚀', 'astronaut', 'space'],
  ['🦸', 'superhero', 'hero'],
  ['🧙', 'mage', 'wizard', 'magic'],
  ['🎅', 'santa', 'christmas'],

  // hearts + symbols of feeling
  ['❤️', 'red heart', 'love', 'heart', '<3'],
  ['🧡', 'orange heart', 'love'],
  ['💛', 'yellow heart', 'love'],
  ['💚', 'green heart', 'love'],
  ['💙', 'blue heart', 'love'],
  ['💜', 'purple heart', 'love'],
  ['🖤', 'black heart', 'love', 'dark'],
  ['🤍', 'white heart', 'love'],
  ['💔', 'broken heart', 'heartbreak', 'sad'],
  ['💖', 'sparkling heart', 'love'],
  ['💯', 'hundred', '100', 'perfect', 'score'],
  ['💢', 'anger', 'mad', 'vein'],
  ['💥', 'collision', 'boom', 'explosion'],
  ['💫', 'dizzy star', 'stars'],
  ['💬', 'speech balloon', 'comment', 'chat'],
  ['💭', 'thought balloon', 'thinking'],
  ['🗯️', 'angry balloon', 'shout'],
  ['💤', 'zzz', 'sleep', 'snore'],

  // nature + animals
  ['🔥', 'fire', 'hot', 'lit', 'burn'],
  ['✨', 'sparkles', 'shiny', 'magic', 'clean'],
  ['⭐', 'star', 'favourite'],
  ['🌟', 'glowing star', 'shine'],
  ['⚡', 'zap', 'lightning', 'fast'],
  ['🌈', 'rainbow', 'pride'],
  ['☀️', 'sun', 'sunny', 'clear'],
  ['🌤️', 'sun behind cloud', 'partly cloudy'],
  ['☁️', 'cloud', 'cloudy'],
  ['🌧️', 'rain', 'raining', 'wet'],
  ['⛈️', 'storm', 'thunder'],
  ['❄️', 'snowflake', 'cold', 'snow'],
  ['🌊', 'wave', 'ocean', 'sea', 'water'],
  ['🌙', 'crescent moon', 'night'],
  ['🌱', 'seedling', 'sprout', 'growth'],
  ['🌲', 'evergreen', 'tree', 'forest'],
  ['🌸', 'blossom', 'flower', 'cherry'],
  ['🌻', 'sunflower', 'flower'],
  ['🍀', 'four leaf clover', 'luck'],
  ['🐶', 'dog', 'puppy'],
  ['🐱', 'cat', 'kitten'],
  ['🐭', 'mouse'],
  ['🦊', 'fox'],
  ['🐻', 'bear'],
  ['🐼', 'panda'],
  ['🐸', 'frog'],
  ['🐝', 'bee', 'honey'],
  ['🐛', 'bug', 'defect', 'caterpillar'],
  ['🦋', 'butterfly'],
  ['🐢', 'turtle', 'slow'],
  ['🐍', 'snake', 'python'],
  ['🦀', 'crab', 'rust'],
  ['🐙', 'octopus'],
  ['🐧', 'penguin', 'linux'],
  ['🦉', 'owl', 'night'],
  ['🦄', 'unicorn', 'magic'],
  ['🐳', 'whale', 'docker'],
  ['🦍', 'gorilla', 'ape'],

  // food + drink
  ['☕', 'coffee', 'tea', 'brew'],
  ['🍵', 'green tea', 'tea'],
  ['🍺', 'beer', 'pint', 'pub'],
  ['🍻', 'cheers', 'beers', 'toast'],
  ['🥂', 'clink', 'champagne', 'celebrate'],
  ['🍷', 'wine', 'glass'],
  ['🍕', 'pizza', 'slice'],
  ['🍔', 'burger', 'hamburger'],
  ['🌮', 'taco'],
  ['🍎', 'apple', 'fruit'],
  ['🍌', 'banana', 'fruit'],
  ['🍰', 'cake', 'slice', 'dessert'],
  ['🎂', 'birthday cake', 'birthday'],
  ['🍪', 'cookie', 'biscuit'],
  ['🍫', 'chocolate', 'sweet'],
  ['🧀', 'cheese'],
  ['🥑', 'avocado'],
  ['🌶️', 'chilli', 'spicy', 'pepper'],
  ['🍿', 'popcorn', 'film', 'watching'],

  // travel + places
  ['🚀', 'rocket', 'launch', 'ship', 'deploy'],
  ['✈️', 'aeroplane', 'plane', 'flight'],
  ['🚗', 'car', 'drive'],
  ['🚲', 'bicycle', 'bike', 'cycle'],
  ['🚂', 'train', 'rail'],
  ['🛟', 'lifebuoy', 'rescue', 'help'],
  ['🏠', 'house', 'home'],
  ['🏢', 'office', 'building', 'work'],
  ['🗺️', 'map', 'world'],
  ['🏔️', 'mountain', 'peak'],
  ['🏖️', 'beach', 'holiday'],
  ['🌍', 'globe', 'earth', 'world'],

  // objects + work
  ['💻', 'laptop', 'computer', 'code'],
  ['🖥️', 'desktop', 'monitor', 'screen'],
  ['⌨️', 'keyboard', 'type'],
  ['🖱️', 'mouse pointer', 'click'],
  ['📱', 'phone', 'mobile'],
  ['💾', 'floppy', 'save', 'disk'],
  ['🗄️', 'file cabinet', 'archive', 'storage'],
  ['📁', 'folder', 'directory'],
  ['📄', 'page', 'document', 'file'],
  ['📋', 'clipboard', 'copy', 'paste'],
  ['📌', 'pin', 'pinned'],
  ['📎', 'paperclip', 'attach', 'attachment'],
  ['✂️', 'scissors', 'cut', 'trim'],
  ['🔍', 'search', 'magnify', 'find', 'zoom'],
  ['🔑', 'key', 'password', 'secret'],
  ['🔒', 'lock', 'locked', 'secure', 'private'],
  ['🔓', 'unlock', 'open', 'public'],
  ['🔔', 'bell', 'notification', 'alert'],
  ['🔕', 'bell off', 'mute', 'silence'],
  ['📣', 'megaphone', 'announce', 'shout'],
  ['🎯', 'target', 'bullseye', 'goal', 'aim'],
  ['🧪', 'test tube', 'experiment', 'test', 'lab'],
  ['🔬', 'microscope', 'research', 'inspect'],
  ['🧲', 'magnet', 'attract'],
  ['🔧', 'wrench', 'fix', 'tool', 'repair'],
  ['🔨', 'hammer', 'build', 'tool'],
  ['🛠️', 'tools', 'maintenance', 'build'],
  ['⚙️', 'gear', 'settings', 'config', 'cog'],
  ['🧹', 'broom', 'cleanup', 'sweep', 'tidy'],
  ['🗑️', 'bin', 'trash', 'delete', 'discard'],
  ['💡', 'bulb', 'idea', 'light', 'insight'],
  ['🕯️', 'candle', 'light'],
  ['📚', 'books', 'library', 'reading'],
  ['📖', 'open book', 'read', 'docs'],
  ['📝', 'memo', 'note', 'write', 'edit'],
  ['✏️', 'pencil', 'write', 'edit'],
  ['📅', 'calendar', 'date', 'schedule'],
  ['⏰', 'alarm clock', 'time', 'reminder'],
  ['⏳', 'hourglass', 'waiting', 'pending', 'time'],
  ['📈', 'chart up', 'growth', 'increase', 'graph'],
  ['📉', 'chart down', 'decline', 'decrease'],
  ['📊', 'bar chart', 'stats', 'graph', 'metrics'],
  ['💰', 'money bag', 'cash', 'budget'],
  ['🎁', 'gift', 'present'],
  ['🎉', 'party popper', 'celebrate', 'hooray', 'tada'],
  ['🎊', 'confetti', 'celebrate'],
  ['🏆', 'trophy', 'win', 'award'],
  ['🥇', 'gold medal', 'first', 'winner'],
  ['🎵', 'music note', 'song', 'sound'],
  ['🎧', 'headphones', 'listen', 'music'],
  ['📷', 'camera', 'photo', 'picture'],
  ['🎬', 'clapper', 'film', 'video', 'action'],
  ['🎮', 'game controller', 'gaming', 'play'],
  ['🎲', 'dice', 'random', 'chance'],
  ['🧩', 'puzzle piece', 'jigsaw', 'plugin'],
  ['⚖️', 'scales', 'balance', 'justice', 'tradeoff'],
  ['🧭', 'compass', 'direction', 'navigate'],
  ['🪄', 'magic wand', 'magic', 'auto'],
  ['🩹', 'plaster', 'bandage', 'patch', 'fix'],

  // symbols + status
  ['✅', 'check', 'done', 'tick', 'yes', 'complete'],
  ['☑️', 'ballot check', 'checkbox', 'done'],
  ['❌', 'cross', 'no', 'fail', 'wrong', 'x'],
  ['⚠️', 'warning', 'caution', 'careful'],
  ['🚫', 'prohibited', 'forbidden', 'no', 'blocked'],
  ['⛔', 'no entry', 'stop', 'blocked'],
  ['❓', 'question', 'query', 'unknown'],
  ['❗', 'exclamation', 'important', 'urgent'],
  ['‼️', 'double exclamation', 'urgent'],
  ['🆕', 'new'],
  ['🆗', 'ok', 'fine'],
  ['🔝', 'top', 'up'],
  ['🔁', 'repeat', 'loop', 'retry'],
  ['🔄', 'refresh', 'sync', 'reload', 'again'],
  ['➡️', 'right arrow', 'next', 'then'],
  ['⬅️', 'left arrow', 'back', 'previous'],
  ['⬆️', 'up arrow', 'up'],
  ['⬇️', 'down arrow', 'down'],
  ['➕', 'plus', 'add'],
  ['➖', 'minus', 'remove', 'subtract'],
  ['✔️', 'heavy tick', 'done', 'yes'],
  ['🟢', 'green circle', 'ok', 'healthy', 'up'],
  ['🟡', 'yellow circle', 'warn', 'degraded'],
  ['🔴', 'red circle', 'error', 'down', 'critical'],
  ['⚫', 'black circle', 'off'],
  ['🔵', 'blue circle', 'info'],
  ['🏳️', 'white flag', 'surrender'],
  ['🏁', 'chequered flag', 'finish', 'race', 'done'],
  ['🚩', 'triangular flag', 'flag', 'mark'],
]

/**
 * THE `:` PICKER'S CANDIDATE SET. A frozen table and a local filter — the
 * catalog owns the matching, as `MacroCatalog` owns `{`'s, so what "matches"
 * means is one method rather than a rule spread across the provider.
 */
export class EmojiCatalog {
  /** @type {readonly Emoji[]} */ #entries

  /** @param {EmojiSpec[]} [table]  the curated table; overridable for a test */
  constructor(table) {
    this.#entries = Object.freeze((table || TABLE).map((spec) => new Emoji(spec)))
  }

  /** @returns {readonly Emoji[]} every entry, in table order */
  get all() { return this.#entries }

  /**
   * The entries matching `prefix`, EXACT TERMS FIRST. The ranking is what makes
   * the old-school sequences work: `:D` leaves the prefix `d`, which is the
   * grinning face's exact keyword and merely the first letter of `dog` — so the
   * face is selected and Enter inserts it. Within a rank the table's own order
   * holds, so the common faces stay at the front.
   *
   * A BLANK PREFIX MATCHES NOTHING. `:` alone is punctuation far more often
   * than it is an emoji, and the provider's `minPrefixLength` means the scanner
   * never asks — this is the same answer stated where the matching lives.
   * @param {string} prefix
   * @returns {Emoji[]}
   */
  search(prefix) {
    const p = (prefix || '').toLowerCase()
    if (!p) return []
    /** @type {Emoji[]} */ const exact = []
    /** @type {Emoji[]} */ const partial = []
    for (const emoji of this.#entries) {
      const terms = emoji.terms
      if (terms.some((t) => t === p)) exact.push(emoji)
      else if (terms.some((t) => t.startsWith(p))) partial.push(emoji)
    }
    return exact.concat(partial)
  }
}
