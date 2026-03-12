-- ================================================================
--  Donkey Kong Country — Level ID Mapping
--  Maps the byte value at WRAM $003E to level info.
--
--  IDs sourced from DKC Atlas PAR Codes (USA v1.0):
--    http://www.dkc-atlas.com/dkc/studies/par_codes
--
--  Use discovery mode in race_tracker.lua to verify:
--    Set DISCOVERY_MODE = true, play through the game, and
--    the script will print each new level ID as you enter it.
-- ================================================================

local DKC_LEVELS = {}

-- Helper to add a level entry
local function add(id, name, worldIdx, levelIdx, progressIdx, isBoss)
  DKC_LEVELS[id] = {
    name = name,
    worldIndex = worldIdx,
    levelIndex = levelIdx,
    progressIndex = progressIdx,
    isBoss = isBoss or false
  }
end

-- ── World 1: Kongo Jungle ─────────────────────────
add(0x16, "Jungle Hijinxs",        0, 0,  0)
add(0x0C, "Ropey Rampage",         0, 1,  1)
add(0x01, "Reptile Rumble",        0, 2,  2)
add(0xBF, "Coral Capers",          0, 3,  3)
add(0x17, "Barrel Cannon Canyon",  0, 4,  4)
add(0xE0, "Very Gnawty",           0, 5,  5, true)

-- ── World 2: Monkey Mines ─────────────────────────
add(0xD9, "Winky's Walkway",       1, 0,  6)
add(0x2E, "Mine Cart Carnage",     1, 1,  7)
add(0x07, "Bouncy Bonanza",        1, 2,  8)
add(0x31, "Stop & Go Station",     1, 3,  9)
add(0x42, "Millstone Mayhem",      1, 4, 10)
add(0xE1, "Master Necky",          1, 5, 11, true)

-- ── World 3: Vine Valley ──────────────────────────
add(0xA5, "Vulture Culture",       2, 0, 12)
add(0xA4, "Tree Top Town",         2, 1, 13)
add(0xD0, "Forest Frenzy",         2, 2, 14)
add(0x43, "Temple Tempest",        2, 3, 15)
add(0x0D, "Orang-utan Gang",       2, 4, 16)
add(0xDE, "Clam City",             2, 5, 17)
add(0xE5, "Queen B.",              2, 6, 18, true)

-- ── World 4: Gorilla Glacier ──────────────────────
add(0x24, "Snow Barrel Blast",     3, 0, 19)
add(0x6D, "Slipslide Ride",        3, 1, 20)
add(0xA7, "Ice Age Alley",         3, 2, 21)
add(0x3E, "Croctopus Chase",       3, 3, 22)
add(0x14, "Torchlight Trouble",    3, 4, 23)
add(0xCE, "Rope Bridge Rumble",    3, 5, 24)
add(0xE2, "Really Gnawty",         3, 6, 25, true)

-- ── World 5: Kremkroc Industries ──────────────────
add(0x40, "Oil Drum Alley",        4, 0, 26)
add(0x2F, "Trick Track Trek",      4, 1, 27)
add(0x18, "Elevator Antics",       4, 2, 28)
add(0x22, "Poison Pond",           4, 3, 29)
add(0x27, "Mine Cart Madness",     4, 4, 30)
add(0x41, "Blackout Basement",     4, 5, 31)
add(0xE3, "Dumb Drum",             4, 6, 32, true)

-- ── World 6: Chimp Caverns ────────────────────────
add(0x30, "Tanked Up Trouble",     5, 0, 33)
add(0x12, "Manic Mincers",         5, 1, 34)
add(0x0A, "Misty Mine",            5, 2, 35)
add(0x36, "Loopy Lights",          5, 3, 36)
add(0x2B, "Platform Perils",       5, 4, 37)
add(0xE4, "Master Necky Snr.",     5, 5, 38, true)

-- ── Final Boss ────────────────────────────────────
add(0xE6, "Gang-Plank Galleon",    6, 0, 39, true)

return DKC_LEVELS
