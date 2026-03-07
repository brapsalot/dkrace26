-- ================================================================
--  Donkey Kong Country — Level ID Mapping
--  Maps the byte value at WRAM $003E to level info.
--
--  IMPORTANT: The level ID values below are based on community
--  documentation but may need adjustment for your specific ROM.
--  Use the discovery mode in race_tracker.lua to verify:
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
add(0x01, "Jungle Hijinxs",        0, 0,  0)
add(0x02, "Ropey Rampage",         0, 1,  1)
add(0x03, "Reptile Rumble",        0, 2,  2)
add(0x04, "Coral Capers",          0, 3,  3)
add(0x05, "Barrel Cannon Canyon",  0, 4,  4)
add(0x06, "Very Gnawty",           0, 5,  5, true)

-- ── World 2: Monkey Mines ─────────────────────────
add(0x07, "Winky's Walkway",       1, 0,  6)
add(0x08, "Mine Cart Carnage",     1, 1,  7)
add(0x09, "Bouncy Bonanza",        1, 2,  8)
add(0x0A, "Stop & Go Station",     1, 3,  9)
add(0x0B, "Millstone Mayhem",      1, 4, 10)
add(0x0C, "Master Necky",          1, 5, 11, true)

-- ── World 3: Vine Valley ──────────────────────────
add(0x0D, "Vulture Culture",       2, 0, 12)
add(0x0E, "Tree Top Town",         2, 1, 13)
add(0x0F, "Forest Frenzy",         2, 2, 14)
add(0x10, "Temple Tempest",        2, 3, 15)
add(0x11, "Orang-utan Gang",       2, 4, 16)
add(0x12, "Queen B.",              2, 5, 17, true)

-- ── World 4: Gorilla Glacier ──────────────────────
add(0x13, "Snow Barrel Blast",     3, 0, 18)
add(0x14, "Slipslide Ride",        3, 1, 19)
add(0x15, "Ice Age Alley",         3, 2, 20)
add(0x16, "Croctopus Chase",       3, 3, 21)
add(0x17, "Torchlight Trouble",    3, 4, 22)
add(0x18, "Really Gnawty",         3, 5, 23, true)

-- ── World 5: Kremkroc Industries ──────────────────
add(0x19, "Oil Drum Alley",        4, 0, 24)
add(0x1A, "Trick Track Trek",      4, 1, 25)
add(0x1B, "Elevator Antics",       4, 2, 26)
add(0x1C, "Poison Pond",           4, 3, 27)
add(0x1D, "Mine Cart Madness",     4, 4, 28)
add(0x1E, "Dumb Drum",             4, 5, 29, true)

-- ── World 6: Chimp Caverns ────────────────────────
add(0x1F, "Tanked Up Trouble",     5, 0, 30)
add(0x20, "Manic Mincers",         5, 1, 31)
add(0x21, "Misty Mine",            5, 2, 32)
add(0x22, "Necky Nutmare",         5, 3, 33)
add(0x23, "Loopy Lights",          5, 4, 34)
add(0x24, "Platform Perils",       5, 5, 35)
add(0x25, "Master Necky Snr.",     5, 6, 36, true)

-- ── Final Boss ────────────────────────────────────
add(0x26, "Gang-Plank Galleon",    6, 0, 37, true)

return DKC_LEVELS
