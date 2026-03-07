-- ================================================================
--  DK Rap Chaos — BizHawk Race Tracker & Input Injector
--
--  Load this script in BizHawk while running Donkey Kong Country.
--  Uses FILE-BASED communication (works with any BizHawk version).
--
--  How it works:
--    1. This script writes progress to bizhawk/state_{name}.json
--    2. A Node.js bridge reads that file and talks to the server
--    3. The bridge writes commands to bizhawk/commands_{name}.json
--    4. This script reads commands and applies them
--
--  Requirements:
--    - BizHawk 2.6+ with Donkey Kong Country (SNES) ROM loaded
--    - Node.js bridge running: node bizhawk-bridge.js Deth
--
--  Usage:
--    1. Edit CONFIGURATION below
--    2. Start the bridge: node bizhawk-bridge.js Deth
--    3. Tools -> Lua Console -> Open Script -> select this file
-- ================================================================

-- ================================================================
--  CONFIGURATION — Edit these for your setup
-- ================================================================

-- Your streamer name (must match config.json on the server)
local STREAMER_NAME = "Deth"

-- Set true to discover level IDs (prints RAM values as you play)
local DISCOVERY_MODE = true

-- How often to write state file (in frames; 60fps so 6 = ~10/sec)
local SEND_INTERVAL = 6

-- How often to check for commands (in frames; 1 = every frame)
local READ_INTERVAL = 1

-- ================================================================
--  File paths — auto-detect script directory with fallbacks
-- ================================================================
local script_dir
-- Try debug.getinfo first
pcall(function()
  local src = debug.getinfo(1, "S").source
  script_dir = src:match("@(.*[\\/])") or src:match("@(.*)")
end)
-- Fallback: hardcode the path (edit this if your project is elsewhere)
if not script_dir or script_dir == "" then
  script_dir = "C:\\Users\\metag\\OneDrive\\Claude\\DK rap\\bizhawk\\"
end
-- Ensure trailing slash
if script_dir:sub(-1) ~= "\\" and script_dir:sub(-1) ~= "/" then
  script_dir = script_dir .. "\\"
end

local STATE_FILE = script_dir .. "state_" .. STREAMER_NAME .. ".json"
local CMD_FILE = script_dir .. "commands_" .. STREAMER_NAME .. ".json"

-- ================================================================
--  DKC RAM Addresses (WRAM offsets, BizHawk uses mainmemory.*)
-- ================================================================
local ADDR_LEVEL_ID     = 0x003E
local ADDR_EXIT_TAKEN   = 0x0040
local ADDR_LEVEL_STATUS = 0x1E15

-- ================================================================
--  Level Mapping
-- ================================================================
local DKC_LEVELS

local ok, result = pcall(function()
  local chunk = loadfile(script_dir .. "dkc_levels.lua")
  if chunk then return chunk() end
  return nil
end)

if ok and result then
  DKC_LEVELS = result
  local count = 0
  for _ in pairs(DKC_LEVELS) do count = count + 1 end
  print("[DK Rap] Loaded level mapping: " .. count .. " levels")
else
  print("[DK Rap] WARNING: Could not load dkc_levels.lua")
  DKC_LEVELS = {}
end

-- ================================================================
--  Minimal JSON encoder / decoder
-- ================================================================
local function json_encode(val)
  if type(val) == "nil" then return "null" end
  if type(val) == "boolean" then return val and "true" or "false" end
  if type(val) == "number" then return tostring(val) end
  if type(val) == "string" then
    return '"' .. val:gsub('\\', '\\\\'):gsub('"', '\\"'):gsub('\n', '\\n') .. '"'
  end
  if type(val) == "table" then
    if #val > 0 or next(val) == nil then
      local parts = {}
      for i, v in ipairs(val) do parts[i] = json_encode(v) end
      return "[" .. table.concat(parts, ",") .. "]"
    end
    local parts = {}
    for k, v in pairs(val) do
      table.insert(parts, json_encode(tostring(k)) .. ":" .. json_encode(v))
    end
    return "{" .. table.concat(parts, ",") .. "}"
  end
  return "null"
end

local function json_decode(str)
  if not str or str == "" or str == "[]" then return nil end
  -- IMPORTANT: convert [] to {} BEFORE adding ["key"]= accessors,
  -- otherwise the bracket swap destroys the key accessors.
  str = str:gsub('%[', '{'):gsub('%]', '}')
  str = str:gsub('"([^"]-)"%s*:', '["%1"]=')
  str = str:gsub(":true", "=true"):gsub(":false", "=false"):gsub(":null", "=nil")
  local fn = load("return " .. str)
  if fn then
    local success, decoded = pcall(fn)
    if success then return decoded end
  end
  return nil
end

-- ================================================================
--  State
-- ================================================================
local injected_buttons = {}
local dk_rap_lockout = false
local frame_counter = 0
local last_level_id = -1
local discovered_ids = {}

-- ================================================================
--  DK Rap Video Playback
-- ================================================================
local DK_RAP_VIDEO_FPS    = 15     -- frames extracted at 15fps
local DK_RAP_FRAME_HOLD   = 4      -- 60fps / 15fps = show each frame for 4 emu frames
local DK_RAP_TOTAL_FRAMES = 2775   -- 185s * 15fps
local DK_RAP_FRAMES_DIR   = script_dir .. "dkrap_frames\\"

local dk_rap_video_active  = false
local dk_rap_frame_counter = 0
local dk_rap_cache_counter = 0

-- Check if frames exist
local function check_dk_rap_frames()
  local test_path = DK_RAP_FRAMES_DIR .. "frame_0001.jpg"
  local f = io.open(test_path, "r")
  if f then
    f:close()
    return true
  end
  return false
end

local dk_rap_frames_available = check_dk_rap_frames()

local function draw_dk_rap_frame()
  if not dk_rap_video_active or not dk_rap_frames_available then return end

  dk_rap_frame_counter = dk_rap_frame_counter + 1

  -- Calculate which video frame to show
  local video_frame_index = math.floor((dk_rap_frame_counter - 1) / DK_RAP_FRAME_HOLD) + 1

  -- Clamp to valid range
  if video_frame_index > DK_RAP_TOTAL_FRAMES then
    video_frame_index = DK_RAP_TOTAL_FRAMES
  end
  if video_frame_index < 1 then video_frame_index = 1 end

  -- Build frame path: frame_0001.jpg through frame_2775.jpg
  local frame_path = string.format("%sframe_%04d.jpg", DK_RAP_FRAMES_DIR, video_frame_index)

  -- Draw the frame over the full SNES game screen
  gui.drawImage(frame_path, 0, 0, 256, 224)

  -- Periodically clear image cache to prevent memory bloat
  dk_rap_cache_counter = dk_rap_cache_counter + 1
  if dk_rap_cache_counter >= 120 then  -- every ~2 seconds at 60fps
    gui.clearImageCache()
    dk_rap_cache_counter = 0
  end
end

-- ================================================================
--  Progress Tracking
-- ================================================================
local function read_progress()
  local levelId = mainmemory.read_u8(ADDR_LEVEL_ID)
  local exitTaken = mainmemory.read_u8(ADDR_EXIT_TAKEN)
  local levelStatus = mainmemory.read_u8(ADDR_LEVEL_STATUS)

  if DISCOVERY_MODE and levelId ~= last_level_id then
    if not discovered_ids[levelId] then
      discovered_ids[levelId] = true
      print(string.format("[DISCOVER] Level ID: 0x%02X (%d)", levelId, levelId))
    end
    last_level_id = levelId
  end

  local info = DKC_LEVELS[levelId]
  local levelName = info and info.name or string.format("Unknown (0x%02X)", levelId)
  local worldIndex = info and info.worldIndex or -1
  local levelIndex = info and info.levelIndex or -1
  local progressIndex = info and info.progressIndex or -1

  return {
    name = STREAMER_NAME,
    levelId = levelId,
    levelName = levelName,
    worldIndex = worldIndex,
    levelIndex = levelIndex,
    progressIndex = progressIndex,
    exitTaken = exitTaken,
    levelStatus = levelStatus,
    timestamp = os.time() * 1000
  }
end

-- ================================================================
--  File I/O Communication
-- ================================================================
local function write_state(progress)
  local body = json_encode(progress)
  local f = io.open(STATE_FILE, "w")
  if f then
    f:write(body)
    f:close()
  end
end

local function read_commands()
  local f = io.open(CMD_FILE, "r")
  if not f then return end
  local content = f:read("*a")
  f:close()

  if not content or content == "" or content == "[]" then return end

  local commands = json_decode(content)
  if not commands then return end

  -- Process each command
  for _, cmd in ipairs(commands) do
    if type(cmd) == "table" then
      if cmd.type == "INJECT_INPUT" then
        injected_buttons = cmd.buttons or {}
        -- Debug: show which buttons are pressed
        local pressed = {}
        for btn, val in pairs(injected_buttons) do
          if val then table.insert(pressed, btn) end
        end
        if #pressed > 0 then
          print("[DK Rap] Input: " .. table.concat(pressed, ", "))
        end
      elseif cmd.type == "DK_RAP_LOCKOUT" then
        dk_rap_lockout = cmd.active or false
        if dk_rap_lockout then
          -- Activate video playback
          dk_rap_video_active = true
          dk_rap_cache_counter = 0

          -- Calculate initial frame offset from server timestamp for sync
          if cmd.startTimestamp and cmd.startTimestamp > 0 then
            local elapsed_ms = (os.time() * 1000) - cmd.startTimestamp
            if elapsed_ms > 0 then
              local offset_frames = math.floor(elapsed_ms / 1000 * DK_RAP_VIDEO_FPS)
              dk_rap_frame_counter = offset_frames * DK_RAP_FRAME_HOLD
              print(string.format("[DK Rap] Video starting at frame %d (offset %dms)", offset_frames, elapsed_ms))
            else
              dk_rap_frame_counter = 0
            end
          else
            dk_rap_frame_counter = 0
          end

          -- Mute game audio so DK Rap audio (from OBS) is heard cleanly
          client.SetSoundOn(false)

          if dk_rap_frames_available then
            print("[DK Rap] LOCKOUT ACTIVE — video playing + audio muted + inputs blocked!")
            print("[DK Rap] Frames dir: " .. DK_RAP_FRAMES_DIR)
          else
            print("[DK Rap] LOCKOUT ACTIVE — audio muted + inputs blocked (no video frames found)")
            print("[DK Rap] Expected frames at: " .. DK_RAP_FRAMES_DIR)
          end
        else
          dk_rap_video_active = false
          dk_rap_frame_counter = 0
          gui.clearImageCache()
          gui.clearGraphics()
          -- Restore game audio
          client.SetSoundOn(true)
          print("[DK Rap] Lockout ended — audio restored + inputs restored")
          injected_buttons = {}
        end
      end
    end
  end
end

-- ================================================================
--  Input Injection
-- ================================================================
local BUTTON_MAP = {
  Up = "Up", Down = "Down", Left = "Left", Right = "Right",
  A = "A", B = "B", X = "X", Y = "Y",
  L = "L", R = "R",
  Start = "Start", Select = "Select"
}

local function apply_inputs()
  if dk_rap_lockout then
    local empty = {}
    for _, snes_btn in pairs(BUTTON_MAP) do
      empty["P1 " .. snes_btn] = false
    end
    joypad.set(empty)
    return
  end

  local has_injection = false
  for _ in pairs(injected_buttons) do has_injection = true; break end

  if has_injection then
    local input = {}
    for web_btn, snes_btn in pairs(BUTTON_MAP) do
      input["P1 " .. snes_btn] = injected_buttons[web_btn] or false
    end
    joypad.set(input)
  end
end

-- ================================================================
--  Main Loop
-- ================================================================
print("\n========================================")
print("  DK Rap Chaos — Race Tracker v3")
print("  Streamer: " .. STREAMER_NAME)
print("  Mode:     File bridge (no network deps)")
print("")
print("  State -> " .. STATE_FILE)
print("  Cmds  <- " .. CMD_FILE)
print("  Video:   " .. (dk_rap_frames_available and (DK_RAP_TOTAL_FRAMES .. " frames ready") or "NO FRAMES (run extract-frames.js)"))
if DISCOVERY_MODE then
  print("  ** DISCOVERY MODE ON **")
end
print("========================================")
print("")
print("[DK Rap] Make sure the bridge is running:")
print("  node bizhawk-bridge.js " .. STREAMER_NAME)
print("")

while true do
  frame_counter = frame_counter + 1

  -- Apply input injection / lockout every frame
  apply_inputs()

  -- Draw DK Rap video frame overlay (when active)
  local draw_ok, draw_err = pcall(draw_dk_rap_frame)
  if not draw_ok and frame_counter % 600 == 0 then
    print("[DK Rap] Video draw error: " .. tostring(draw_err))
  end

  -- Read commands from bridge
  if frame_counter % READ_INTERVAL == 0 then
    local cmd_ok, cmd_err = pcall(read_commands)
    if not cmd_ok and frame_counter % 600 == 0 then
      -- Only warn every 10 seconds to avoid spam
      print("[DK Rap] Command read error: " .. tostring(cmd_err))
    end
  end

  -- Write progress to state file periodically
  if frame_counter % SEND_INTERVAL == 0 then
    local progress = read_progress()
    local write_ok, write_err = pcall(write_state, progress)
    if not write_ok and frame_counter % 600 == 0 then
      print("[DK Rap] State write error: " .. tostring(write_err))
    end
  end

  emu.frameadvance()
end
