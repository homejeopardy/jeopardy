#!/bin/bash
# Double-click to start the Jeopardy server, then open the control panel.
cd "$(dirname "$0")"
(sleep 1 && open "http://localhost:3300/control") &
node server.js
