# Trust 1 Services Veterans Day Office TV

Static GitHub Pages slideshow for the office TV at Trust 1 Services Plumbing, Heating and Air Conditioning in Quincy and Hanover, Massachusetts. Twenty-two silent 15-second clips play in order, each through to the end, then the loop starts over.

The TV opens <https://hustl-boards.github.io/Trust1-Veterans-Day-Board/>.

The board is one full-screen stage: a thin progress bar, controls that appear when someone moves the pointer, a screen wake lock, and a reload so a TV left on for weeks picks up changes. Clips live in `assets/clips/`. The Trust 1 Services logo sits larger on a solid black plate over each clip's footer. Gold stays in the logo. The countdown, progress bar, and controls are dark and have no gold frame. The line "Thank you to all who served — from Trust 1 Services" sits beside the logo on the title and tribute clips. That line uses a clamped size and can wrap to two balanced lines so the words stay inside the plate. The closing clip keeps the logo plate only. The plate is the same two elements for the life of the page. A clip change reuses them, and the short cover over the previous footer is one timeout, cleared on the next change and when the page hides. `assets/trust-1-services-logo.svg` is the source artwork. `assets/trust1-logo.png` is the render the page shows.

## Publish on GitHub Pages

The page is a normal static site. It does not call the GitHub API.

1. Push this folder to `main`.
2. In GitHub: **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
4. Branch: **main**. Folder: **/** (root).
5. Open <https://hustl-boards.github.io/Trust1-Veterans-Day-Board/> on the TV browser.

Pages can take a minute after the push. The TV may keep the previous `index.html` for about 10 minutes. The board reloads itself every 4 hours, after the current clip finishes, and again about 15 minutes later if that ending never comes. The reload URL carries a fresh `v=` value so the TV asks for the new page instead of a cached copy.

`.nojekyll` is in the repo so Pages serves the files as they are.

## Controls

Right arrow or Space: next · Left arrow: previous · P: pause · M: sound on/off · F: fullscreen

Clips start muted so Chrome and TV browsers allow autoplay. M, or the sound button, turns sound on. The clips in this set are silent.

Move the pointer to see the controls and the clip count (`3 / 22`). The cursor and the controls hide again after a few seconds of idle. The countdown chip sits in the top-right, inset about 5% from the screen edge so television overscan does not crop it, and clears the title line and the faces on the tribute clips. It shows whole calendar days until Wednesday, November 11, 2026 in America/New_York, for example `12 days until Veterans Day`, and `1 day until Veterans Day` on November 10. The clock is Eastern time no matter what timezone the TV is set to. On November 11 it reads `Happy Veterans Day / Today`. After that day it keeps `HAPPY VETERANS DAY — THANK YOU FOR YOUR SERVICE`. The chip is a fixed size, so the digits changing does not move anything else. It refreshes about once a minute on the board's pulse and pauses while the document is hidden. The Eastern-time formatter is created once. Building a new one on every tick is what leaked memory on the office TV after the live countdown shipped.

## URL options

- `?reload=4` reloads every 4 hours (the default), after the current clip ends. `?reload=0` turns that off. `?hard=15` is how many minutes after that deadline the page reloads even if the clip never ends (the default, so about 4 hours 15 minutes).
- `?maxclip=60` is a hard cap per video, in seconds (default 60). A normal clip ends itself first.
- `?stall=8` skips a clip whose playback time has not moved for 8 seconds (the default). An error, a real abort, or three of those failures in a row reloads the page. One bad file is skipped and the loop continues. If the network is down, the board keeps trying cached clips instead of navigating to an error page.
- `?shuffle=1` randomizes the order when the page loads.
- `?slide=3` starts on that clip (1 is the first).
- `?date=2026-10-28` previews the countdown as of midnight Eastern on that day. `?date=2026-11-11` shows the Veterans Day line. `?date=2026-11-12` shows the thank-you that stays up afterward.
- `?fresh=1` loads a new page for every clip. Last resort for a TV that still leaks memory.
- `?debug=1` shows the clip name, uptime, page loads, and the last problem.

A clip that errors, or never produces a picture, is skipped. One bad file does not stop the board.

## Add or remove a clip

`clips.js` is the only playlist. The board plays that list from top to bottom. It does not scan the folder.

1. Put a 16:9 file in `assets/clips/` (MP4, WebM, or MOV). 1920×1080 is what the current clips are. Number the name (`vd21-your-title.mp4`) so the order stays obvious.
2. Add a line to `window.CLIPS` where that clip should play. To take a clip off the board, delete that line. The file can stay in the folder or go with it.
3. Commit and push to `main`.

Renaming a file does not change the order. The list does.

When you replace a file and keep the same name, change the `?v=` text on that line (any new string). That is the cache buster, same idea as the Halloween board. Leave `?v=` alone when the bytes did not change, or the TV downloads the clip again for no reason.

`app.js`, `clips.js`, `styles.css`, and the logo are linked with `?v=20261030f`. Bump that text in `index.html` when you change those files so the TV does not keep an old copy.

## Keeping the picture moving

Two `<video>` elements are created once and reused. One plays the current clip. The other holds only the next clip, paused, so the cut does not wait on a cold decoder. Anything else is detached (`pause`, `src` removed, `load()`) before the next file is assigned, including a stray element if something else creates one. Media listeners and the one-second pulse are registered once, not on every clip. A script error or an unhandled rejection skips a stuck clip and, if faults keep coming, arms the between-clip page reload instead of rebooting inside the error handler.

A clip that does not advance for about 8 seconds, or that errors, is skipped. Three skips in a row with no successful playback reload the page. That reload is suppressed for a few minutes if one just happened, so a bad file cannot reboot the TV in a loop. While the network is down the same loop keeps going from cache, and coming back online resumes playback.

The screen wake lock is requested where the browser allows it, including again when the page becomes visible. The countdown and the stall check pause while the document is hidden.

After the scheduled reload the page resumes on the next clip, rather than jumping back to the first one. The reload address includes `v=` set to the current time so a new deploy is not stuck behind a cached `index.html`.

## Encoding

Every shipped clip is 1920×1080, 24 fps, 15.0 seconds, faststart, plus a silent AAC track. The set is about 79 MB. The six largest files (Kennedy, the Tuskegee Airmen, the Navajo code talkers, Glenn, Freeman, and Powell) are H.264 Main profile level 4.0 with no B-frames at about 2 Mbps, which is what a memory-limited TV can keep decoded alongside the next clip. The other clips are still H.264 High profile level 4.1. Desktop Chrome plays both.

A lot of TVs only hardware-decode Baseline or Main. High profile with B-frames can stay black, which is what the Halloween board ran into. If this TV does that, re-encode on a computer, put the new file in place of the old one, change `?v=`, and push:

```bash
ffmpeg -y -i "INPUT.mp4" \
  -c:v libx264 -profile:v main -level:v 4.0 -pix_fmt yuv420p \
  -r 24 -b:v 1800k -maxrate 2200k -bufsize 3600k -bf 0 \
  -an \
  -movflags +faststart \
  "OUTPUT.mp4"
```

If the picture is still black, use `-profile:v baseline -level:v 4.0 -bf 0` in place of the Main profile line.
