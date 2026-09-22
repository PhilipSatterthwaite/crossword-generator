// Everything fillmein says, in one place.
//
// Edit the words under a [key] and run: python web/build_site.py
// The pages carry {{key}} marks saying where each block goes, so you never have to open the HTML.
//
// How the text is written:
//   A blank line starts a new paragraph.
//   **bold**  and  [a link](privacy.html)  work anywhere.
//   Lines starting with "- " become a bulleted list.
//   "## " and "### " are headings. [[contents]] becomes a list of that block's ## headings.
//   A paragraph starting with "<" is markup and is passed through untouched.
//   Lines starting with // are notes like this one and never appear on the site.
//
// Not in here: button labels, and anything a page writes while you use it (status lines, warnings,
// the wording in popups). Those live in the pages and scripts themselves.


// ============================================================ the home page

[home.title]
fillmein · make crosswords

[home.description]
Build crosswords with scored word lists and an autofill that knows real crossword fill.

[home.social.title]
fillmein · make crosswords

[home.social.description]
Build crosswords with a scored word list and an autofill that knows real crossword fill. Free, in your browser.

[home.lede]
Construct a crossword completely free with our automatic grid-filling software.

[home.new.heading]
Start a new puzzle

[home.new.body]
Begin with a blank 15×15 grid. Change the size or load an example, draw your blocks, ink your theme answers and let autofill do the rest.

[home.keep.heading]
Keep working

[home.keep.empty]
Puzzles you start show up here, so you can pick up where you left off.

[home.keep.signedout]
to save your puzzles to your account and pick them up on any device. Until then they're saved in this browser.

[home.keep.signedin]
Saved to your account, so they're here on every device you sign in on.

// The "Solve a shared puzzle" card is off the home page for now (taken off 19 September 2026).
// Its words are kept below as notes, so it can come back as it was.
// [home.solve.heading]
// Solve a shared puzzle
//
// [home.solve.body]
// Been sent a fillmein link? Open it and solve the puzzle right here, with no account needed. To share one of yours, finish it and use **Share a link** on its Export tab.
//
// [home.solve.soon]
// Browsing published puzzles: soon

[home.quick.heading]
Quick add

[home.quick.body]
Put a word into one of your word lists, with a score from 0 to 100. Every puzzle that fills from that list will use it.

// Shown under the form while there's no list of your own to add to yet.
[home.quick.first]
You don't have a word list of your own yet, so the first word you add starts one: the built-in list plus the words you add. Pick it for a puzzle from the List menu on the Grid page.

[home.guide.heading]
How to make a crossword

[home.guide.body]
New to constructing? Our step-by-step guide takes you from an empty grid to a finished puzzle.

[home.welcome.heading]
Welcome to *fillmein*

[home.welcome.body]
Crossword puzzles have existed for over 100 years, but the barrier to entry for creating them still seems insurmountable to many. It's really freaking hard to fill a grid with diverse and interesting words. Even today with powerful computers at our fingertips, grid-filling software programs are quirky and unreliable, and most importantly they sit behind a paywall. That's why we made ***fillmein***, a completely free crossword constructing page that runs in your web browser!

If you're new to this, check out the [How to make a crossword](guide.html) guide to walk you through the process and provide some helpful tips. We hope that veteran constructors will find everything they need on this page. If something isn't up to snuff or if you'd like to see some new features, please [contact](contact.html) us. This website is still in its early test phase, and we'd love to make improvements that matter to you!

Whether you're making something fun for your friends or looking to publish your puzzle in a newspaper, this site aims to make the process as fun and painless as possible. Happy puzzling!


// A short note under the welcome. The privacy page has the whole story; keep this one in step with it.
[home.privacy]
**Your privacy.** Your puzzles and word lists are yours and are not shared with anyone. We never sell your data. The only personal details we keep come from signing in: your email, and your name if you use Google. We also count visits with Google Analytics and log errors so we can fix them. The [privacy page](privacy.html) has the rest.


// ============================================================ the guide

[guide.title]
How to make a crossword · fillmein

[guide.description]
A step-by-step guide to building a professional crossword

[guide.social.title]
How to make a crossword

[guide.social.description]
Cruciverbalism made easy!

[guide.heading]
How to make a crossword

[guide.standfirst]
This guide goes from empty square to publishable product, with the conventions editors expect and the places a first puzzle usually goes wrong.

// The whole article. The three lines of markup below draw the box around the contents list;
// [[contents]] fills it from the "## " headings further down, so renaming a step renames its link too.
[guide.body]
<nav class="contents" aria-labelledby="contents-title">
<p id="contents-title">On this page</p>

[[contents]]

</nav>

## 1. Solve first, then choose your puzzle

The constructors who get published are nearly all heavy solvers. Solving tells you what a Monday feels like next to a Saturday, which words turn up week after week, and which clues make you smile. If you have a publication in mind, solve a month of its puzzles before you build one for it.

Then decide what you're making. A **themed** puzzle has a handful of long answers that share one idea: a pun played four ways, a hidden word, a category with a twist. The theme is the reason the puzzle exists, and the rest of the grid is built around it. A **themeless** puzzle has no such center. Its pleasure is the fill itself, long and lively entries stacked against each other, and it's judged almost entirely on how fresh those words are.

Sizes follow the newspaper week. A daily is 15×15. Monday through Thursday are usually themed and get harder as the week goes on, and Friday and Saturday are usually themeless and hardest. A Sunday is a 21×21 themed puzzle. Many constructors' first acceptance is an early-week themed 15×15. For your very first grid, though, build a 7×7: it teaches the same lessons in ten minutes rather than an afternoon.

## 2. Find a theme worth a puzzle

Editors turn down more puzzles for the theme than for anything else. A theme that gets accepted tends to have four qualities.

- **It has an aha.** Solvers should feel the moment they catch on. A list of things that merely share a category, such as five kinds of cheese, rarely does it.
- **It's consistent.** Every theme entry follows exactly the same rule. If three answers hide a planet across two words, the fourth can't hide it inside one.
- **It's tight.** The idea picks the entries, rather than you picking them. If a dozen other phrases would fit the rule just as well, ask why these ones.
- **It's fresh.** Search past puzzles on XWord Info or Crossword Tracker before you build. A great idea that ran two years ago is a rejection.

Theme answers should be real phrases people say, not strings built to fit the gimmick. Many early-week themes end with a **revealer**, one last entry, often near the bottom, that names the idea and makes the aha land.

Plan the theme answers before drawing a single block, because every other decision bends around them. Three to five is typical for a 15×15.

- They're almost always Across, spread down the grid rather than bunched together.
- They sit in mirrored rows: an entry in row 3 pairs with one in row 13, and one in row 5 with one in row 11.
- Paired entries have the same length, so the blocks around them mirror each other.
- An entry in the exact middle row has to be centered, so it needs an odd number of letters.

Two theme answers of awkward, unmatched lengths can make a grid impossible before you've typed a letter. So can two long theme answers in neighboring rows, where every Down entry has to cross both.

## 3. Design the grid

American-style crosswords follow four rules that editors treat as absolute. Break one and the puzzle isn't publishable, however good the fill.

<div class="rules">

### The blocks are rotationally symmetric

Turn the grid 180 degrees and the black squares land exactly where they were. Keep **Mirror blocks** ticked and fillmein places each block's partner as you draw. The tally under the grid tells you whether the symmetry holds. Some editors accept left-right mirror symmetry when a theme truly needs it, but rotational is the default.

### No entry is shorter than three letters

Two-letter entries aren't allowed. The autofill refuses a grid that contains one and tells you which run is too short.

### Every square is checked

Each white square belongs to both an Across entry and a Down entry, so every letter can be worked out two ways. Select a square that isn't and fillmein calls it an unchecked square.

### The grid is one piece

You can walk from any white square to any other. A corner sealed off by blocks is a separate puzzle, not a section of this one.

</div>

Beyond those rules, a few numbers keep a grid in normal territory. At the New York Times, a themed 15×15 has at most 78 entries, a themeless at most 72, and a 21×21 Sunday at most 140. Other outlets are close. Black squares traditionally stay at about a sixth of the grid. Editors no longer hold to that strictly, but large clumps of blocks look lazy. The tally under the grid shows **Words**, and **Blocks** with its percentage, as you draw.

Good grids also flow. Each corner should open onto the rest of the grid through more than one square, so a solver who's stuck in one section can get in from another. Use "cheater" squares sparingly. These are blocks that make the grid easier to fill without changing its word count. And leave room for a few long non-theme entries, seven to ten letters in the corners. They're where the grid's sparkle comes from.

Beginners almost always use too many blocks. The result is a grid full of three- and four-letter entries, which is where dull fill comes from. Fewer blocks and longer entries make a better puzzle and a harder build.

## 4. Fill it

fillmein keeps the letters you chose apart from the letters it suggested. Letters you type or pick are **ink** and are never touched. Letters the autofill puts in are **pencil**, shown in blue, and are replaced whenever you fill again. So ink your theme answers first, then let the machine work around them.

Press **Fill grid** and the solver looks for a complete fill. **Another fill** searches again from a different starting point, which is how you shop for a version you like. After you change a letter or a block, **Fill grid** keeps as much of the fill already there as still works. Three settings steer it:

- **Min. score** is the floor. Scores run 0 to 100: 50 is ordinary fill, 60 and up is lively, and below 50 is weak. Start at 50 and raise it as far as the grid allows.
- **Allow popular below it** lets in everyday words that score under your floor. It helps a stubborn grid close.
- The box next to them sets how many **seconds** the search may take before it gives up. A tight grid may need a minute.

To choose an entry yourself, click it. The panel beside the grid lists every word that fits the letters already there, best score first, and checks each one against the rest of the grid. A tick means a full fill exists with that word in place, and a struck-through word means no fill does. Click a word to preview it, and press Enter to keep it.

The autofill is a starting point, not the finished fill. Experienced constructors fill the hardest corner by hand, redo any section they don't love, and use software for the rest. When a grid won't fill at all, the answer is almost always the grid rather than the settings. Move one block. A single square in the wrong place is usually what's strangling a corner.

## 5. Clean up the fill

A complete grid isn't a finished puzzle. What separates a good crossword from a bad one is whether solvers recognize the words in it and enjoy finding them. Editors look hard at the weakest parts of a grid, and these are the problems that most often sink an otherwise good puzzle:

- **Crosswordese.** Short, vowel-heavy words that exist mainly in crosswords, such as old coins, obscure rivers and rare birds. A few are unavoidable. A grid full of them needs redrawing.
- **Unfair crossings.** Two obscure names crossing at a letter no one could infer is a trap, not a challenge. Constructors call it a Natick, and editors reject puzzles for it.
- **Filler that isn't a word.** Partial phrases like A TO or IN AN, arbitrary abbreviations, Roman numerals, and made-up words glued together from a prefix or suffix, like REEMAIL or UNSOGGY.
- **The breakfast test.** Nothing gross, offensive or grim that a solver wouldn't want to meet over their morning coffee.
- **Repeats.** The same word, or the same root, shouldn't appear twice in one puzzle.

fillmein points you at all of these. **Weakest entry** in the tally names the worst word in your grid and its score, so if you fix one thing, fix that. Tick **Tint weak words** and any entry scoring under 50 is shaded on the grid, so bad corners are visible at a glance. An entry that repeats a word used elsewhere is flagged **also at** on the grid and in the entry list.

## 6. Write the clues

Numbering happens automatically and follows the grid, so the Clues tab always matches what you've drawn. What's left is the writing, and it's where a puzzle gets its voice.

- **Match the answer exactly.** The clue and the answer agree in part of speech, tense and number. A plural answer gets a plural clue, and a past-tense answer gets a past-tense clue.
- **Signal what's unusual.** An abbreviated answer needs an abbreviation in the clue, or a tag such as "for short" or "briefly." A question mark at the end marks wordplay rather than a straight definition. Use it honestly and sparingly.
- **Never give the answer away.** A clue must not contain any word from its own answer.
- **Pitch it to the day.** A Monday clue should be gettable by someone new to crosswords. A Saturday clue can misdirect, as long as it's fair once you see the answer.
- **Find a fresh angle.** Look up how an entry has been clued before, then try to say something new. A clue with a little personality is remembered, and the stock one isn't.
- **Check every fact.** Dates, spellings, titles, who said what. A single wrong fact is the kind of error an editor notices first.

If you change a letter on the grid after writing its clue, the Clues tab marks that clue as written for an answer that has since changed. Nothing goes out describing a word that's no longer there.

## 7. Read it like an editor

An editor reading your puzzle asks four questions: Is the theme worth it? Is the fill clean and lively? Are the clues accurate and pitched right for the day? Would solvers enjoy the whole thing? Answer those yourself before anyone else has to.

- **Get it test-solved.** Send it to two or three people who solve regularly and watch where they stall. A square nobody can get is a square to fix.
- **Proofread it cold.** Put the puzzle down for a day, then read every clue against its answer.
- **Let the Export tab check it.** It confirms that every square is filled, every entry is clued, every clue still matches its answer, and the puzzle has a title.

From there you can download the puzzle as **.puz**, which nearly every solving app opens, as **.ipuz**, the open standard and the format to keep your own copy in, or as **.jpz** for Crossword Compiler and many web solvers. **Print or PDF** lays the puzzle and its clues on a single sheet with the answer key on a second. **Share a link** lets anyone you send the address to solve it in their browser, with no account and nothing to install. That makes it the easy way to get test-solvers.

## 8. Submit it

Pick an outlet and read its specifications before you build, not after. Grid sizes, word counts and what an editor will accept vary, and they're all easier to hit from the start than to retrofit. For the New York Times, the specifications and the submission form are on [its crossword submissions page](https://www.nytimes.com/puzzles/submissions/crossword). The Times asks for a PDF in its own layout, with the filled grid and each clue beside its answer. Export a .puz from fillmein and a free converter will lay it out that way.

A few courtesies apply almost everywhere:

- **One outlet at a time.** Don't send the same puzzle anywhere else while it's under review. After a rejection, it's free to go elsewhere.
- **Keep it unpublished.** Outlets want puzzles no one has seen. Share it with your test-solvers, not with the whole internet.
- **Don't flood the queue.** Editors limit how many of your puzzles can wait at once, the Times included.

Then be patient. Replies take months, and the big outlets receive hundreds of puzzles a week, so most submissions are declined, including many good ones. A rejection often comes with a note on what didn't work. Read it, revise, and try the Los Angeles Times, Universal, the Wall Street Journal or an independent outlet. An acceptance usually comes with edits, and editors often rewrite some of the clues.

You don't have to do it alone. Plenty of first bylines come from co-constructing with someone who has been published. Communities like Crosscord, a Discord server for constructors, and the Crossword Puzzle Collaboration Directory, which pairs newcomers from underrepresented groups with mentors, are good places to find test-solvers, feedback and a partner. Most published constructors collected a stack of rejections before their first yes.

[guide.ready]
**Ready?** Start with a 7×7 and let the autofill show you what a grid wants to do. You can change the size, load an example to pull apart, or open a puzzle you made elsewhere.


// ============================================================ the privacy page

[privacy.title]
Privacy · fillmein

[privacy.description]
What fillmein keeps, where, who can see it, and how to delete it.

[privacy.social.title]
Privacy · fillmein

[privacy.social.description]
What fillmein keeps, where, who can see it, and how to delete it.

[privacy.heading]
Privacy

[privacy.when]
What fillmein keeps, where it goes, and how to get rid of it. Last changed 18 September 2026.

[privacy.body]
## Without an account

Your puzzles, word lists and settings are saved in your own browser and nowhere else. Clearing the browser's site data removes them. Nothing you type reaches our team.

## With an account

Signing in stores your puzzles and word lists in the site's database (Google Firebase) so they follow you between devices, along with the email address of the account. They are stored as they are, not encrypted, so our team, who run the database, can read them. Nobody else using the site can: each account can only reach its own.

## Puzzles you share

Sharing a link publishes that puzzle's grid, answers, clues, title and author name. Anyone with the link can read all of it, along with an identifier for your account. Stop sharing on the puzzle's Export tab and the link stops working.

## Counting visits

Every page counts visits with Google Analytics and Cloudflare Web Analytics. They see the page's address and the usual details a browser sends, such as its type and rough location, and Google Analytics sets cookies to tell repeat visits apart. A page's address can include a puzzle's id, which for a shared puzzle is also its link.

## When you write to us

The contact form keeps what you type — your message, and the name and email address you choose to give — where only our team can read it, along with your browser's name and version and your account identifier if you're signed in. It is not passed to anyone else, and the email address you give is used to answer you and nothing else.

## When something breaks

If a page hits an error, it sends a short report: the error's text, the page's name (not the puzzle), the browser's name and version, and your account identifier if you're signed in. Only our team can read these, and they exist so that faults get fixed.

## Deleting everything

- Puzzles in your browser: delete them on the My puzzles page.
- A shared puzzle: Stop sharing on its Export tab.
- Your account, with every puzzle, word list and setting stored in it: the button below. It can't be undone, and it doesn't touch the copies in this browser.

[privacy.delete.signedout]
to delete your account.

[privacy.delete.signedin]
Deleting the account removes it and everything stored in it, on every device, for good.

[privacy.end]
Questions about any of this go to our team on the [Contact](contact.html) page.


// ============================================================ the contact page

[contact.title]
Contact · fillmein

[contact.description]
Send a message to the people who make fillmein.

[contact.heading]
Contact

[contact.lede]
A question, something broken, a word the list should or shouldn't have: write it here and it comes straight to us.

[contact.field.name]
Your name

[contact.field.name.note]
optional

[contact.field.email]
Your email

[contact.field.email.note]
so we can write back

[contact.field.message]
Message

[contact.sent.heading]
Message sent


// ============================================================ the page that isn't there

[notfound.title]
Not found · fillmein

[notfound.heading]
That page isn't here

[notfound.body]
The address may be mistyped, or the page may have moved. A puzzle shared with you opens from its own link, which starts with **fillmein.org/solve.html**.


// ============================================================ the grid page

[grid.title]
Grid · fillmein

[grid.description]
Build a crossword grid, see scored word options for any entry, and fill the rest with real crossword words.

[grid.social.title]
Grid · fillmein

[grid.social.description]
Build a crossword grid, see scored word options for any entry, and fill the rest with real crossword words.

[grid.missing.heading]
That puzzle isn't in this browser

[grid.missing.body]
The link names a puzzle this browser doesn't have. If it's in your account, sign in and it opens here as soon as it arrives. If it was deleted, the link is dead.

[grid.theme.heading]
Theme entries

[grid.theme.note]
Words this puzzle must include. Autofill puts any you haven't inked wherever they fit. To pick the spot yourself, select an entry and use Put in.

[grid.scores]
Word scores run 0 to 100. They start from Peter Broda's scored word list (July 2023), the list many constructors load into Crossfire, where 50 is ordinary fill, 60 and up is lively and under 50 is weak. His list gives hundreds of thousands of words a flat 50, obscure and everyday alike, so each score is then nudged by popularity: up to 10 points for words everyone knows, down as much as 20 for words almost nobody uses. Popularity comes from everyday-English word frequencies (wordfreq by Robyn Speer, CC BY-SA 4.0) and, counting for less, how often a word has appeared in published crosswords. The 9,357 published answers his list lacks are unvetted and score 40 at most. "Allow popular words below it" lets autofill and word options also use words under the minimum that are popular: everyday single words that score at least 40, since they help grids fill. Entries you ink completely, like theme answers, don't need to be in the list.


// ============================================================ the clues page

[clues.title]
Clues · fillmein

[clues.description]
Write the clues for a fillmein crossword.

[clues.social.title]
Clues · fillmein

[clues.social.description]
Write the clues for a fillmein crossword.

[clues.empty.heading]
No grid yet

[clues.empty.body]
Clues follow the grid you build on the Grid tab. Build or fill one there, then come back to write its clues.

[clues.note.squares]
Click a square to jump to its clue; click again for the other direction. Press Enter in a clue to move to the next one.

[clues.note.next]
When the clues are done, name and download the puzzle on the [Export](export.html) tab.


// ============================================================ the export page

[export.title]
Export · fillmein

[export.description]
Name a fillmein crossword and download it as .puz, .ipuz or .jpz, or print it.

[export.social.title]
Export · fillmein

[export.social.description]
Name a fillmein crossword and download it as .puz, .ipuz or .jpz, or print it.

[export.empty.heading]
Nothing to export yet

[export.empty.body]
Build a grid on the Grid tab and write its clues on the Clues tab; this page turns them into files you can share or print.

[export.details.heading]
Details

[export.check.heading]
Before you export

[export.download.heading]
Download

[export.format.puz]
Across Lite, which most solving apps open. Needs every square filled.

[export.format.ipuz]
The open crossword standard, and a good backup copy.

[export.format.jpz]
Crossword Compiler and many web solvers. Needs every square filled.

[export.format.print]
The puzzle with its clues, then an answer key.

[export.share.heading]
Share a link

[export.share.lede]
Send the puzzle to someone and they can solve it in their browser. No account needed to solve.

[export.save.note]
Your grid, clues and details save automatically as you work: to your account when you're signed in, and in this browser either way. Download an .ipuz to keep a copy anywhere else.

[export.preview.heading]
The printed puzzle


// ============================================================ the solve page

[solve.title]
Solve · fillmein

[solve.description]
Solve a crossword someone made with fillmein.

[solve.social.title]
Solve a crossword on fillmein

[solve.social.description]
Someone made you a crossword. Open the link and solve it in your browser; no account needed.

[solve.missing.heading]
That link doesn't open a puzzle

[solve.missing.body]
The puzzle may have been unshared by whoever made it, or the link may be incomplete. Ask them for a fresh link.

[solve.done.heading]
Solved!

[solve.done.link]
Make your own crossword with fillmein


// ============================================================ my puzzles

[puzzles.title]
My puzzles · fillmein

[puzzles.description]
Every crossword you have started, in folders you can open, nest, sort and rename.

[puzzles.social.title]
My puzzles · fillmein

[puzzles.social.description]
Every crossword you have started, in folders.
