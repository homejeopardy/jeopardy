# Jeopardy!

A classroom Jeopardy game with four kinds of screens.

**Play it: https://homejeopardy.github.io/jeopardy/**

Open that page on each device and choose what it is:

| Screen | Page | Runs on |
|---|---|---|
| Host control panel | [control.html](https://homejeopardy.github.io/jeopardy/control.html) | the computer the USB buzzers are plugged into |
| Game board | [board.html](https://homejeopardy.github.io/jeopardy/board.html) | projector / TV |
| Contestant | [contestant.html](https://homejeopardy.github.io/jeopardy/contestant.html) | each player's phone or tablet |
| Podium display | [podium.html](https://homejeopardy.github.io/jeopardy/podium.html) | a tablet at each podium |

The control panel shows a **room code**. The other screens type it in, or scan a QR code from **Setup → Devices**. Screens connect straight to the control panel over the internet ([PeerJS](https://peerjs.com)). The control panel runs the game and saves it in that browser, so keep it open. Reloading it is fine.

## Playing without internet (optional)

If the school network blocks the online version, run the game from your own computer instead. Every device must be on the same Wi-Fi:

```
node server.js
```

Or double-click **`Start Jeopardy.command`** on a Mac. Needs [Node.js](https://nodejs.org). The server prints the address for each screen.

## Features

- Jeopardy, Double Jeopardy and Final Jeopardy, with Daily Doubles
- Board fill, clue zoom, Daily Double splash, generated sound effects and think music
- Buzzers open under host control, with an early-buzz lockout; a wrong answer reopens them for the others
- Podium countdown lights after a player buzzes in
- Final Jeopardy wagers and responses typed on contestant devices
- Undo for scoring mistakes; the game survives a server restart

## USB buzzers

Buzzers that act as a keyboard or game controller work out of the box. In **Setup → Buzzers**, click **Learn** for a player, then press their buzzer. Keep the control panel or game board window in front so it receives the presses. For testing without buzzers, turn on **Buzz button on contestant phones** in Settings.

## Writing a game

Make a spreadsheet and save it as CSV (Google Sheets: File → Download → .csv), then drop it into **Setup → Game file**. See [`docs/sample-game.csv`](docs/sample-game.csv).

```
round,category,value,clue,answer,daily_double
J,SCIENCE,200,H2O is the chemical formula for this,What is water?,
DJ,SPACE,400,It's the closest planet to the sun,What is Mercury?,yes
FJ,U.S. STATES,,The only one-syllable state,What is Maine?,
```

- `round`: `J`, `DJ` or `FJ` (one FJ row)
- Up to 6 categories × 5 clues per round, in board order
- `value` is optional (defaults to 200–1000 / 400–2000)
- `daily_double`: `yes` to place one. If none are marked, 1 (J) and 2 (DJ) are hidden at random.
