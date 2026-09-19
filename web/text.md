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

[home.solve.heading]
Solve a shared puzzle

[home.solve.body]
Been sent a fillmein link? Open it and solve the puzzle right here, with no account needed. To share one of yours, finish it and use **Share a link** on its Export tab.

[home.solve.soon]
Browsing published puzzles: soon

[home.welcome.heading]
Welcome to *fillmein*

[home.welcome.body]
Crossword puzzles have existed for over 100 years, but the barrier to entry for creating them has always been quite high. It's really freaking hard to fill a grid with long, diverse, and interesting words. Even in the modern computer age, grid-filling software programs are quirky and unreliable, and most importantly they sit behind a paywall. That's why we made ***fillmein***, a completely free crossword constructing page that runs in your web browser!

If you're new to this, check out the [How to make a crossword](guide.html) guide to walk you through the process and provide some helpful tips. We hope that veteran constructors will find everything they need on this page. If something isn't up to snuff or if you'd like to see some new features, please [contact](contact.html) us. This website is still in its early test phase, and we'd love to make improvements that matter to you!

Whether you're making something fun for your friends or looking to publish your puzzle in a newspaper, this site aims to make the process as fun and painless as possible. Happy puzzling!


// A short note under the welcome. The privacy page has the whole story; keep this one in step with it.
[home.privacy]
**Your privacy.** You don't need an account: without one, your puzzles never leave this browser. If you sign in, they're kept in our database so they follow you between devices. We count page views to see how the site gets used, but never on the page where a shared puzzle is solved. The [privacy page](privacy.html) has the details.


// ============================================================ the guide

[guide.title]
How to make a crossword · fillmein

[guide.description]
A step-by-step guide to building a crossword: choosing a theme, drawing a symmetric grid, filling it with words solvers know, writing the clues, and sharing the finished puzzle.

[guide.social.title]
How to make a crossword

[guide.social.description]
From an empty grid to a finished puzzle: themes, grid rules, fill, clues and export, explained for a first-time constructor.

[guide.heading]
How to make a crossword

[guide.standfirst]
A crossword starts as an empty square and ends as something a stranger can solve on a train. Here is the whole road between, with the conventions editors expect and the places a first puzzle usually goes wrong.

// The whole article. The three lines of markup below draw the box around the contents list;
// [[contents]] fills it from the "## " headings further down, so renaming a step renames its link too.
[guide.body]
<nav class="contents" aria-labelledby="contents-title">
<p id="contents-title">On this page</p>

[[contents]]

</nav>

## 1. Decide what kind of puzzle it is

A **themed** puzzle has a handful of long answers that share an idea: a pun repeated four ways, a hidden word, a category. The theme is the reason the puzzle exists, and everything else in the grid is built to accommodate it. Most weekday newspaper crosswords are themed.

A **themeless** puzzle has no such centre. Its pleasure is the fill itself: long, lively, surprising entries stacked against each other. Themelesses are harder to fill and are usually judged on how fresh the words are.

On size, the standard weekday grid is 15×15, a Sunday is 21×21, and a mini is 5×5 or 7×7. If this is your first puzzle, build a 7×7. It teaches the same lessons in ten minutes rather than an afternoon.

## 2. Place the theme first

Theme answers go in before a single block is drawn, because every other decision bends around them. Pick three to five for a 15×15. Then arrange them so the grid can stay symmetric:

- Theme entries are almost always Across, and are spread down the grid rather than bunched.
- They sit in mirrored rows. An entry in row 3 pairs with one in row 13; an entry in row 5 pairs with one in row 11. A single odd entry can sit in the exact middle row.
- Paired entries are the same length, so the blocks that bound them mirror each other.

This is the step people skip, and it is the step that decides whether the puzzle is buildable. Two theme answers of awkward, unmatched lengths can make a grid impossible before you have typed a letter.

## 3. Draw the grid

American-style crosswords follow four rules that editors treat as absolute. Break one and the puzzle is not publishable, however good the fill.

<div class="rules">

### The blocks are rotationally symmetric

Turn the grid 180 degrees and the black squares land exactly where they were. Keep **Mirror blocks** ticked and fillmein places each block's partner as you draw. The tally under the grid tells you whether the symmetry holds.

### No entry is shorter than three letters

Two-letter entries are not allowed. The autofill refuses a grid that contains one and tells you which run is too short.

### Every square is checked

Each white square belongs to both an Across entry and a Down entry, so every letter can be worked out two ways. Select a square that isn't and fillmein calls it an unchecked square.

### The grid is one piece

You can walk from any white square to any other. A corner sealed off by blocks is a separate puzzle, not a section of this one.

</div>

Beyond those, two numbers tell you whether a grid is in normal territory. A 15×15 should come in at no more than 78 entries if it's themed, 72 if it's themeless, and its black squares should stay at roughly a sixth of the grid or below. Both appear in the tally under the grid as you draw: **Words**, and **Blocks** with its percentage.

Beginners almost always use too many blocks. The result is a grid full of three- and four-letter entries, which is where dull fill comes from. Fewer blocks and longer entries make a better puzzle and a harder build.

## 4. Fill it

fillmein separates the letters you chose from the letters it suggested. Letters you type or pick are **ink** and are never touched. Letters the autofill puts in are **pencil**, shown in blue, and are replaced every time you fill again. So type your theme answers first, then let the machine work around them.

Press **Fill grid** and the solver looks for a complete fill. **Another fill** searches again from a different starting point, which is how you shop for a version you like. Three settings steer it:

- **Min. word score** is the floor. Scores run 0 to 100: 50 is ordinary fill, 60 and up is lively, below 50 is weak. Starting at 50 and raising it is a good habit.
- **Allow popular words below it** lets in everyday words that score under your floor. It helps a stubborn grid close.
- **Search for** is how many seconds it may spend before giving up. A tight grid may need a minute.

To choose an entry yourself, click it. The panel beside the grid lists every word in the list that fits the letters already there, best score first, and then works down the list checking which of them the rest of the grid can still accommodate: a tick means a full fill exists with that word in place, a struck-through word means no fill does. Click one to preview it, press Enter to keep it.

When a grid will not fill, the answer is almost always the grid rather than the settings. Move one block. A single square in the wrong place is usually what's strangling a corner.

## 5. Judge the fill

A complete grid is not a finished puzzle. What separates a good crossword from a bad one is whether a solver recognises the words in it.

- **Weakest entry** in the tally names the worst word in your grid and its score. If you fix one thing, fix that.
- Tick **Tint weak words** and any entry scoring under 50 is shaded on the grid, so bad corners are visible at a glance.
- Watch for crosswordese: the short, vowel-heavy words that exist only in crosswords. A few are unavoidable. A grid full of them is a grid that needs redrawing.
- An entry that repeats a word used elsewhere is flagged **also at** on the grid and in the entry list. The same word must not appear twice in one puzzle.

## 6. Write the clues

Numbering happens automatically and follows the grid, so the Clues tab always matches what you have drawn. What's left is the writing, where a few conventions matter:

- The clue and the answer must match in part of speech, tense and number. If the answer is a plural, the clue is plural; if the answer is past tense, so is the clue.
- An abbreviated answer needs a signal: an abbreviation in the clue, or a tag such as "for short" or "briefly".
- A question mark at the end marks wordplay rather than a straight definition. Use it honestly and sparingly.
- A clue must not contain any word from its own answer.
- Vary the difficulty. A puzzle of nothing but dictionary definitions is a vocabulary test, not a crossword.

If you change a letter on the grid after writing its clue, the Clues tab marks that clue as written for an answer that has since changed, so nothing goes out describing a word that is no longer there.

## 7. Check it, then send it out

The Export tab runs through the puzzle before you do anything with it: every square filled, every entry clued, every clue still matching its answer, and a title on the whole thing. Clear those four and it is ready.

From there you can download the puzzle as **.puz**, which nearly every solving app opens, as **.ipuz**, the open standard and the format to keep your own copy in, or as **.jpz** for Crossword Compiler and many web solvers. **Print or PDF** lays the puzzle and its clues on a single sheet with the answer key on a second. **Share a link** publishes it so anyone you send the address to can solve it in their browser, with no account and nothing to install.

If you are aiming at a publication, read its specifications before you build, not after. Word counts, grid sizes and what an editor will accept vary, and they are all easier to hit from the start than to retrofit.

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
What fillmein keeps, where it goes, and how to get rid of it. Last changed 17 September 2026.

[privacy.body]
## Without an account

Your puzzles, word lists and settings are saved in your own browser and nowhere else. Clearing the browser's site data removes them. Nothing you type reaches our team.

## With an account

Signing in stores your puzzles and word lists in the site's database (Google Firebase) so they follow you between devices, along with the email address of the account. They are stored as they are, not encrypted, so our team, who run the database, can read them. Nobody else using the site can: each account can only reach its own.

## Puzzles you share

Sharing a link publishes that puzzle's grid, answers, clues, title and author name. Anyone with the link can read all of it, along with an identifier for your account. Stop sharing on the puzzle's Export tab and the link stops working.

## Counting visits

The construction pages count page views with Google Analytics and Cloudflare Web Analytics, which see the page address and the usual details a browser sends. The page where a shared puzzle is solved is not counted by either, so the link to a puzzle shared privately reaches neither.

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
