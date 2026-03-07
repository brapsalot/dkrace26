"""
DK RAP CHAOS — Streamer Client
================================
Each streamer runs this script during the race.
When a viewer triggers the DK Rap, this script will:
  1. Lock your controller (see LOCK_METHOD below)
  2. Play the DK Rap
  3. Unlock your controller when it ends

Requirements:
  pip install websockets

Optional (for virtual gamepad lock):
  pip install vgamepad inputs
  + Install ViGEmBus driver: https://github.com/nefarius/ViGEmBus/releases

Run: python streamer_client.py
"""

import asyncio
import json
import os
import subprocess
import sys
import threading
import time
import webbrowser

import websockets

# ================================================================
#  ✏️  CONFIGURATION — Edit these for your setup
# ================================================================

# Your deployed server URL (Railway, Render, etc.)
# During local testing you can use: ws://localhost:3000
SERVER_URL    = "ws://localhost:3000"

# Your streamer name (shown on the viewer page)
STREAMER_NAME = "Streamer1"

# ── DK Rap source ────────────────────────────────────────────
# Option A: Local file (MP4/MKV/etc.) — set path or leave None
DK_RAP_LOCAL = None
# Example Windows:  r"C:\Videos\dk_rap.mp4"
# Example Mac/Linux: "/home/you/Videos/dk_rap.mp4"

# Option B: YouTube URL (opened in browser if no local file found)
DK_RAP_YOUTUBE   = "https://www.youtube.com/watch?v=eJqnWqsGMn0"
DK_RAP_DURATION  = 185   # seconds — how long to stay locked (default: full DK Rap ~3:05)

# ── Controller lockout ───────────────────────────────────────
# "vgamepad"  → Virtual gamepad proxy. Point your emulator to the virtual
#               controller this script creates. Requires ViGEmBus + vgamepad.
#               Best for USB SNES controllers.
# "keyboard"  → Suppresses keyboard input. Use if your emulator is on keyboard.
#               Requires:  pip install pynput
# "none"      → No lockout. Honor system — just watch the rap 🦍
LOCK_METHOD = "none"

# ================================================================

_locked    = threading.Event()
_kb_listener = [None]   # holds pynput listener when active


# ── Controller lock helpers ─────────────────────────────────

def start_vgamepad_proxy():
    """
    Create a virtual Xbox 360 gamepad and forward your physical
    controller to it. Stops forwarding when _locked is set.
    """
    try:
        import vgamepad as vg
        import inputs
    except ImportError:
        print("⚠️  vgamepad/inputs not installed — falling back to no lockout")
        print("   Run:  pip install vgamepad inputs")
        return None

    virtual = vg.VX360Gamepad()
    print("✅  Virtual Xbox 360 gamepad created")
    print("    ➡  In your emulator, select 'Virtual Xbox 360 Controller #1' as your input device")

    def proxy_loop():
        AXIS_MAP = {
            'ABS_X':  ('left_joystick_x',),
            'ABS_Y':  ('left_joystick_y',),
            'ABS_RX': ('right_joystick_x',),
            'ABS_RY': ('right_joystick_y',),
        }
        BTN_MAP = {
            'BTN_SOUTH': vg.XUSB_BUTTON.XUSB_GAMEPAD_A,
            'BTN_EAST':  vg.XUSB_BUTTON.XUSB_GAMEPAD_B,
            'BTN_NORTH': vg.XUSB_BUTTON.XUSB_GAMEPAD_Y,
            'BTN_WEST':  vg.XUSB_BUTTON.XUSB_GAMEPAD_X,
            'BTN_TL':    vg.XUSB_BUTTON.XUSB_GAMEPAD_LEFT_SHOULDER,
            'BTN_TR':    vg.XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_SHOULDER,
            'BTN_SELECT':vg.XUSB_BUTTON.XUSB_GAMEPAD_BACK,
            'BTN_START': vg.XUSB_BUTTON.XUSB_GAMEPAD_START,
        }
        while True:
            try:
                events = inputs.get_gamepad()
                if _locked.is_set():
                    virtual.reset()
                    virtual.update()
                    continue

                for ev in events:
                    if ev.ev_type == 'Key' and ev.code in BTN_MAP:
                        btn = BTN_MAP[ev.code]
                        if ev.state:
                            virtual.press_button(button=btn)
                        else:
                            virtual.release_button(button=btn)
                        virtual.update()
                    elif ev.ev_type == 'Absolute' and ev.code in AXIS_MAP:
                        # Normalize -32768..32767 → -1.0..1.0
                        val = ev.state / 32768.0
                        axis = AXIS_MAP[ev.code][0]
                        if 'x' in axis:
                            if 'left' in axis:
                                virtual.left_joystick_float(x_value_float=val, y_value_float=0)
                            else:
                                virtual.right_joystick_float(x_value_float=val, y_value_float=0)
                        virtual.update()
            except Exception:
                time.sleep(0.05)

    t = threading.Thread(target=proxy_loop, daemon=True)
    t.start()
    return virtual


def lock_keyboard():
    """Suppress all keyboard events using pynput."""
    try:
        from pynput import keyboard
        listener = keyboard.Listener(suppress=True)
        listener.start()
        _kb_listener[0] = listener
        print("🔒  Keyboard suppressed")
    except ImportError:
        print("⚠️  pynput not installed — keyboard lock unavailable")
        print("   Run:  pip install pynput")


def unlock_keyboard():
    if _kb_listener[0]:
        _kb_listener[0].stop()
        _kb_listener[0] = None
        print("🔓  Keyboard restored")


# ── DK Rap playback ─────────────────────────────────────────

def play_dk_rap():
    """Play local file if available, otherwise open YouTube."""
    if DK_RAP_LOCAL and os.path.exists(DK_RAP_LOCAL):
        print(f"🎵  Playing: {DK_RAP_LOCAL}")
        if sys.platform == 'win32':
            # Open with default media player and wait for process
            proc = subprocess.Popen(['cmd', '/c', 'start', '/wait', '', DK_RAP_LOCAL])
            proc.wait()
        elif sys.platform == 'darwin':
            proc = subprocess.Popen(['open', '-W', DK_RAP_LOCAL])
            proc.wait()
        else:
            proc = subprocess.Popen(['xdg-open', DK_RAP_LOCAL])
            time.sleep(DK_RAP_DURATION)
    else:
        print(f"🎵  Opening YouTube: {DK_RAP_YOUTUBE}")
        webbrowser.open(DK_RAP_YOUTUBE)
        time.sleep(DK_RAP_DURATION)


# ── DK Rap event handler ─────────────────────────────────────

def handle_dk_rap(donor_name: str, amount: float, virtual_pad=None):
    print(f"\n{'='*50}")
    print(f"  🦍🦍🦍  DK RAP TRIGGERED  🦍🦍🦍")
    print(f"  Donor: {donor_name}  |  Amount: ${amount}")
    print(f"{'='*50}\n")

    # Lock
    if LOCK_METHOD == "vgamepad" and virtual_pad:
        _locked.set()
        virtual_pad.reset()
        virtual_pad.update()
        print("🔒  Controller locked — you can't escape the music")
    elif LOCK_METHOD == "keyboard":
        lock_keyboard()

    # Play
    play_dk_rap()

    # Unlock
    if LOCK_METHOD == "vgamepad" and virtual_pad:
        _locked.clear()
        print("🔓  Controller unlocked — good luck catching up")
    elif LOCK_METHOD == "keyboard":
        unlock_keyboard()

    print("\n✅  DK Rap sequence complete. Back to speedrunning!\n")


# ── Main WebSocket loop ──────────────────────────────────────

async def main():
    virtual_pad = None

    if LOCK_METHOD == "vgamepad":
        virtual_pad = start_vgamepad_proxy()
    elif LOCK_METHOD == "keyboard":
        print("ℹ️  Keyboard lock mode — keyboard will be suppressed during DK Rap")

    print(f"\n🎮  Connecting to {SERVER_URL} as '{STREAMER_NAME}'...")

    while True:
        try:
            async with websockets.connect(SERVER_URL) as ws:
                await ws.send(json.dumps({
                    "type": "REGISTER_STREAMER",
                    "name": STREAMER_NAME
                }))
                print(f"✅  Connected and registered!")
                print(f"    Watching for DK Rap triggers...\n")

                async for raw in ws:
                    msg = json.loads(raw)
                    if msg.get("type") == "DK_RAP":
                        threading.Thread(
                            target=handle_dk_rap,
                            args=(msg["donorName"], msg["amount"], virtual_pad),
                            daemon=True
                        ).start()

        except (websockets.exceptions.ConnectionClosed, OSError) as e:
            print(f"❌  Connection lost: {e}")
            print(f"    Retrying in 5 seconds...")
            await asyncio.sleep(5)
        except KeyboardInterrupt:
            print("\n👋  Client shutting down")
            break


if __name__ == "__main__":
    asyncio.run(main())
