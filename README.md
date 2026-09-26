# Jeopardy!

A classroom Jeopardy game with four kinds of screens, all running from one computer over Wi-Fi. No installs beyond [Node.js](https://nodejs.org).

| Screen | Address | Runs on |
|---|---|---|
| Host control panel | `http://localhost:3300/control` | the host computer only |
| Game board | `http://<host-ip>:3300/board` | projector / TV |
| Contestant | `http://<host-ip>:3300/contestant?p=1` (2, 3) | each player's device |
| Podium display | `http://<host-ip>:3300/podium?p=1` (2, 3) | a tablet at each podium |

## Run it

Double-click **`Start Jeopardy.command`** (Mac), or:

```
node server.js
```

The server prints the addresses to open. Every device must be on the same Wi-Fi as the host. Allow incoming connections for `node` if the Mac asks.

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

Make a spreadsheet and save it as CSV (Google Sheets: File → Download → .csv), then drop it into **Setup → Game file**. See [`sample-game.csv`](sample-game.csv).

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
